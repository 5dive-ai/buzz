import Darwin
import Foundation

public enum PushConsumptionStateError: Error, Equatable {
  case lockFailed(Int32)
}

public struct PushEventPosition: Codable, Equatable, Comparable, Sendable {
  public let createdAt: Int
  public let id: String

  enum CodingKeys: String, CodingKey {
    case createdAt = "created_at"
    case id
  }

  public init(createdAt: Int, id: String) {
    self.createdAt = createdAt
    self.id = id
  }

  public static func < (lhs: PushEventPosition, rhs: PushEventPosition) -> Bool {
    lhs.createdAt == rhs.createdAt ? lhs.id < rhs.id : lhs.createdAt < rhs.createdAt
  }
}

public struct PushOriginState: Codable, Equatable, Sendable {
  public let cursor: PushEventPosition?
  public let delivered: [PushEventPosition]

  public init(cursor: PushEventPosition? = nil, delivered: [PushEventPosition] = []) {
    self.cursor = cursor
    self.delivered = delivered
  }

  public func contains(eventID: String) -> Bool {
    delivered.contains { $0.id == eventID }
  }

  public func consuming(
    _ position: PushEventPosition,
    deliveredLimit: Int = PushConsumptionState.maximumDeliveredPerOrigin
  ) -> PushOriginState {
    let nextCursor = max(cursor ?? position, position)
    var byID = Dictionary(uniqueKeysWithValues: delivered.map { ($0.id, $0) })
    byID[position.id] = position
    let bounded = byID.values
      .filter { $0.createdAt >= nextCursor.createdAt }
      .sorted()
      .suffix(deliveredLimit)
    return PushOriginState(cursor: nextCursor, delivered: Array(bounded))
  }
}

public struct PushConsumptionState: Codable, Equatable, Sendable {
  public static let version = 1
  public static let maximumDeliveredPerOrigin = 64
  public static let allowedFutureSkewSeconds = 300

  public var origins: [String: PushOriginState]

  private let storedVersion: Int

  enum CodingKeys: String, CodingKey {
    case storedVersion = "version"
    case origins
  }

  public init(origins: [String: PushOriginState] = [:]) {
    storedVersion = Self.version
    self.origins = origins
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let decodedVersion = try container.decode(Int.self, forKey: .storedVersion)
    guard decodedVersion == Self.version else {
      throw DecodingError.dataCorruptedError(
        forKey: .storedVersion,
        in: container,
        debugDescription: "Unsupported push consumption state version \(decodedVersion)"
      )
    }
    storedVersion = decodedVersion
    origins = try container.decode([String: PushOriginState].self, forKey: .origins)
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(storedVersion, forKey: .storedVersion)
    try container.encode(origins, forKey: .origins)
  }

  public func state(for origin: String) -> PushOriginState {
    origins[origin] ?? PushOriginState()
  }

  public func querySince(for origin: String, now: Int = Int(Date().timeIntervalSince1970)) -> Int? {
    guard let timestamp = origins[origin]?.cursor?.createdAt else { return nil }
    return min(timestamp, now)
  }

  public func hasConsumed(eventID: String, for origin: String) -> Bool {
    state(for: origin).contains(eventID: eventID)
  }

  public func canSelect(
    _ position: PushEventPosition,
    for origin: String,
    now: Int = Int(Date().timeIntervalSince1970),
    allowedFutureSkew: Int = allowedFutureSkewSeconds
  ) -> Bool {
    let originState = state(for: origin)
    return position.createdAt <= now + allowedFutureSkew
      && position.createdAt >= (originState.cursor?.createdAt ?? position.createdAt)
      && !originState.contains(eventID: position.id)
  }

  public mutating func consume(
    _ position: PushEventPosition,
    for origin: String,
    deliveredLimit: Int = maximumDeliveredPerOrigin
  ) {
    origins[origin] = state(for: origin).consuming(position, deliveredLimit: deliveredLimit)
  }

  public mutating func removeInactiveOrigins(_ activeOrigins: Set<String>) {
    origins = origins.filter { activeOrigins.contains($0.key) }
  }
}

public protocol PushConsumptionStateLocking: Sendable {
  func withExclusiveLock<T>(_ body: () throws -> T) throws -> T
}

public protocol PushConsumptionStatePersisting: Sendable {
  func read() throws -> Data?
  func write(_ data: Data) throws
}

public struct PushFileLock: PushConsumptionStateLocking {
  private let url: URL

  public init(url: URL) {
    self.url = url
  }

  public func withExclusiveLock<T>(_ body: () throws -> T) throws -> T {
    let descriptor = open(url.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw PushConsumptionStateError.lockFailed(errno) }
    defer { close(descriptor) }
    guard flock(descriptor, LOCK_EX) == 0 else {
      throw PushConsumptionStateError.lockFailed(errno)
    }
    defer { flock(descriptor, LOCK_UN) }
    return try body()
  }
}

public struct PushFilePersistence: PushConsumptionStatePersisting {
  private let url: URL

  public init(url: URL) {
    self.url = url
  }

  public func read() throws -> Data? {
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    return try Data(contentsOf: url)
  }

  public func write(_ data: Data) throws {
    try data.write(to: url, options: [.atomic])
  }
}

public final class PushConsumptionStateStore: @unchecked Sendable {
  private let lock: any PushConsumptionStateLocking
  private let persistence: any PushConsumptionStatePersisting
  private let encoder: JSONEncoder
  private let decoder: JSONDecoder

  public init(
    lock: any PushConsumptionStateLocking,
    persistence: any PushConsumptionStatePersisting
  ) {
    self.lock = lock
    self.persistence = persistence
    encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    decoder = JSONDecoder()
  }

  public convenience init(containerURL: URL) {
    self.init(
      lock: PushFileLock(url: containerURL.appendingPathComponent("push-consumption-state.lock")),
      persistence: PushFilePersistence(
        url: containerURL.appendingPathComponent("push-consumption-state.json")
      )
    )
  }

  public func read() throws -> PushConsumptionState {
    try lock.withExclusiveLock { try loadUnlocked() }
  }

  @discardableResult
  public func update(
    _ body: (inout PushConsumptionState) throws -> Void
  ) throws -> PushConsumptionState {
    try lock.withExclusiveLock {
      var state = try loadUnlocked()
      try body(&state)
      try persistence.write(encoder.encode(state))
      return state
    }
  }

  private func loadUnlocked() throws -> PushConsumptionState {
    guard let data = try persistence.read() else { return PushConsumptionState() }
    return try decoder.decode(PushConsumptionState.self, from: data)
  }
}
