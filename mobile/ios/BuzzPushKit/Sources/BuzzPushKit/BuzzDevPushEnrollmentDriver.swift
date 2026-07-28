import CryptoKit
import Foundation

#if canImport(Security)
  import Security
#endif

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// The opaque gateway capability and binding metadata needed by a later lease publisher.
public struct BuzzPushEndpointGrantRecord: Codable, Equatable, Sendable {
  public let relayOrigin: String
  public let relayPubkey: String
  public let endpointGrant: String
  public let endpointHash: String
  public let appProfile: String
  public let endpointEpoch: Int64
  public let generation: Int64
  public let expiresAt: Int64

  public init(
    relayOrigin: String,
    relayPubkey: String,
    endpointGrant: String,
    endpointHash: String,
    appProfile: String,
    endpointEpoch: Int64,
    generation: Int64,
    expiresAt: Int64
  ) {
    self.relayOrigin = relayOrigin
    self.relayPubkey = relayPubkey
    self.endpointGrant = endpointGrant
    self.endpointHash = endpointHash
    self.appProfile = appProfile
    self.endpointEpoch = endpointEpoch
    self.generation = generation
    self.expiresAt = expiresAt
  }
}

/// Persistence boundary for endpoint grants. The Runner implementation stores
/// records in its Keychain access group and exposes them over the Flutter bridge.
public protocol BuzzPushEndpointGrantStore {
  func records() throws -> [BuzzPushEndpointGrantRecord]
  func save(_ record: BuzzPushEndpointGrantRecord) throws
}

#if DEBUG
  public enum BuzzDevPushEnrollmentError: Error, LocalizedError, Equatable {
    case invalidGatewayURL
    case invalidRelayURL
    case invalidRelayDescriptor
    case invalidResponse(route: String)
    case unexpectedStatus(route: String, expected: Int, actual: Int, body: String)
    case randomGenerationFailed(Int32)

    public var errorDescription: String? {
      switch self {
      case .invalidGatewayURL:
        return "The development push gateway URL must be an HTTP or HTTPS origin."
      case .invalidRelayURL:
        return "The relay URL must be a ws or wss origin."
      case .invalidRelayDescriptor:
        return "NIP-11 must contain exactly one valid current push key."
      case .invalidResponse(let route):
        return "The response from \(route) did not match the closed push protocol."
      case .unexpectedStatus(let route, let expected, let actual, let body):
        return "The response from \(route) was HTTP \(actual), expected \(expected): \(body)"
      case .randomGenerationFailed(let status):
        return "Secure random generation failed with status \(status)."
      }
    }
  }

  protocol BuzzDevAppAttesting {
    func prepareAttestation() throws -> BuzzDevAttestation
    func attestation(_ prepared: BuzzDevAttestation, clientData: Data) throws -> BuzzDevAttestation
    func assertion(clientData: Data) throws -> String
  }

  struct BuzzDevAttestation: Equatable {
    let keyId: String
    let attestation: String
  }

  struct BuzzDevAppAttestProvider: BuzzDevAppAttesting {
    private static let attestationPrefix = Data("buzz-dev-app-attest-v1:".utf8)
    private static let assertionBytes = Data("buzz-dev-app-assertion-v1".utf8)

    let randomBytes: () throws -> Data

    init(randomBytes: @escaping () throws -> Data = BuzzDevAppAttestProvider.secureRandomBytes) {
      self.randomBytes = randomBytes
    }

    func prepareAttestation() throws -> BuzzDevAttestation {
      let entropy = try randomBytes()
      precondition(entropy.count == 32, "Development attestation entropy must be exactly 32 bytes")
      let bytes = Self.attestationPrefix + entropy
      return BuzzDevAttestation(
        keyId: Data(SHA256.hash(data: bytes)).base64EncodedString(),
        attestation: bytes.base64EncodedString()
      )
    }

    func attestation(_ prepared: BuzzDevAttestation, clientData: Data) throws -> BuzzDevAttestation
    {
      precondition(!clientData.isEmpty, "Enrollment client data must not be empty")
      return prepared
    }

    func assertion(clientData: Data) throws -> String {
      precondition(!clientData.isEmpty, "Delegation client data must not be empty")
      return Self.assertionBytes.base64EncodedString()
    }

    private static func secureRandomBytes() throws -> Data {
      var bytes = [UInt8](repeating: 0, count: 32)
      let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
      guard status == errSecSuccess else {
        throw BuzzDevPushEnrollmentError.randomGenerationFailed(status)
      }
      return Data(bytes)
    }
  }

  /// DEBUG-only enrollment and delegation driver for the gated gateway bypass.
  /// This type and both sentinel byte strings are absent from non-DEBUG builds.
  public final class BuzzDevPushEnrollmentDriver {
    public static let appProfile = "buzz-ios-sandbox"
    public static let endpointEpoch: Int64 = 1
    public static let generation: Int64 = 1

    private let gatewayBaseURL: URL
    private let store: BuzzPushEndpointGrantStore
    private let session: URLSession
    private let appAttest: BuzzDevAppAttesting
    private let now: () -> Date
    private let lifetimeSeconds: Int64

    public convenience init(
      gatewayBaseURL: URL,
      store: BuzzPushEndpointGrantStore,
      session: URLSession = .shared
    ) throws {
      try self.init(
        gatewayBaseURL: gatewayBaseURL,
        store: store,
        session: session,
        appAttest: BuzzDevAppAttestProvider(),
        now: Date.init,
        lifetimeSeconds: 2_592_000
      )
    }

    init(
      gatewayBaseURL: URL,
      store: BuzzPushEndpointGrantStore,
      session: URLSession,
      appAttest: BuzzDevAppAttesting,
      now: @escaping () -> Date,
      lifetimeSeconds: Int64
    ) throws {
      guard Self.isHTTPOrigin(gatewayBaseURL), lifetimeSeconds > 0 else {
        throw BuzzDevPushEnrollmentError.invalidGatewayURL
      }
      self.gatewayBaseURL = gatewayBaseURL
      self.store = store
      self.session = session
      self.appAttest = appAttest
      self.now = now
      self.lifetimeSeconds = lifetimeSeconds
    }

    public func endpointGrants() throws -> [BuzzPushEndpointGrantRecord] {
      try store.records()
    }

    /// Fetches the relay's current NIP-11 push key, enrolls the APNs endpoint,
    /// delegates to that key, and durably saves the resulting opaque grant.
    public func enroll(
      deviceToken: Data,
      relayURL: URL
    ) async throws -> BuzzPushEndpointGrantRecord {
      precondition(!deviceToken.isEmpty, "The APNs device token must not be empty")
      let relayOrigin = try Self.relayOrigin(relayURL)
      let relayPubkey = try await fetchCurrentRelayPushPubkey(from: relayOrigin.url)
      let endpoint = Self.lowercaseHex(deviceToken)
      let endpointHash = Self.lowercaseHex(Data(SHA256.hash(data: deviceToken)))
      let nowSeconds = Int64(now().timeIntervalSince1970)

      if let current = try store.records().first(where: {
        $0.relayOrigin == relayOrigin.text
          && $0.relayPubkey == relayPubkey
          && $0.endpointHash == endpointHash
          && $0.appProfile == Self.appProfile
          && $0.endpointEpoch == Self.endpointEpoch
          && $0.generation == Self.generation
          && $0.expiresAt > nowSeconds + 300
      }) {
        return current
      }

      let (expiresAt, expiresOverflow) = nowSeconds.addingReportingOverflow(lifetimeSeconds)
      guard !expiresOverflow else {
        throw BuzzDevPushEnrollmentError.invalidGatewayURL
      }

      let enrollmentChallenge = try await challenge()
      let preparedAttestation = try appAttest.prepareAttestation()
      let enrollmentClientData = try BuzzPushTranscript.enroll(
        challengeId: enrollmentChallenge.id,
        challenge: enrollmentChallenge.value,
        keyId: preparedAttestation.keyId,
        appProfile: Self.appProfile,
        endpoint: endpoint,
        endpointEpoch: Self.endpointEpoch,
        expiresAt: expiresAt
      )
      let attestation = try appAttest.attestation(
        preparedAttestation,
        clientData: enrollmentClientData
      )
      guard attestation.keyId == preparedAttestation.keyId else {
        throw BuzzDevPushEnrollmentError.invalidResponse(route: "development attestation")
      }
      let installation = try await enrollInstallation(
        challenge: enrollmentChallenge,
        endpoint: endpoint,
        expiresAt: expiresAt,
        attestation: attestation
      )

      let delegationChallenge = try await challenge()
      let delegationClientData = try BuzzPushTranscript.delegate(
        challengeId: delegationChallenge.id,
        challenge: delegationChallenge.value,
        installationHandle: installation,
        endpointEpoch: Self.endpointEpoch,
        generation: Self.generation,
        relayPubkey: relayPubkey,
        notBefore: nowSeconds,
        expiresAt: expiresAt
      )
      let assertion = try appAttest.assertion(clientData: delegationClientData)
      let endpointGrant = try await delegate(
        challenge: delegationChallenge,
        installationHandle: installation,
        relayPubkey: relayPubkey,
        notBefore: nowSeconds,
        expiresAt: expiresAt,
        assertion: assertion
      )

      let record = BuzzPushEndpointGrantRecord(
        relayOrigin: relayOrigin.text,
        relayPubkey: relayPubkey,
        endpointGrant: endpointGrant,
        endpointHash: endpointHash,
        appProfile: Self.appProfile,
        endpointEpoch: Self.endpointEpoch,
        generation: Self.generation,
        expiresAt: expiresAt
      )
      try store.save(record)
      return record
    }

    private func challenge() async throws -> Challenge {
      let response: ChallengeResponse = try await post(
        route: "v1/installations/challenges",
        expectedStatus: 200,
        body: VersionRequest(v: 1)
      )
      guard let id = UUID(uuidString: response.challengeId),
        response.challengeId == id.uuidString.lowercased(),
        Self.isBase64URLChallenge(response.challenge),
        response.expiresAt > Int64(now().timeIntervalSince1970)
      else {
        throw BuzzDevPushEnrollmentError.invalidResponse(route: "v1/installations/challenges")
      }
      return Challenge(id: id, value: response.challenge)
    }

    private func enrollInstallation(
      challenge: Challenge,
      endpoint: String,
      expiresAt: Int64,
      attestation: BuzzDevAttestation
    ) async throws -> UUID {
      let response: InstallationResponse = try await post(
        route: "v1/installations",
        expectedStatus: 201,
        body: InstallationRequest(
          v: 1,
          challengeId: challenge.id.uuidString.lowercased(),
          challenge: challenge.value,
          keyId: attestation.keyId,
          attestation: attestation.attestation,
          appProfile: Self.appProfile,
          endpoint: endpoint,
          endpointEpoch: Self.endpointEpoch,
          expiresAt: expiresAt
        )
      )
      guard let installation = UUID(uuidString: response.installationHandle),
        response.installationHandle == installation.uuidString.lowercased(),
        response.endpointEpoch == Self.endpointEpoch,
        response.expiresAt == expiresAt
      else {
        throw BuzzDevPushEnrollmentError.invalidResponse(route: "v1/installations")
      }
      return installation
    }

    private func delegate(
      challenge: Challenge,
      installationHandle: UUID,
      relayPubkey: String,
      notBefore: Int64,
      expiresAt: Int64,
      assertion: String
    ) async throws -> String {
      let response: DelegationResponse = try await post(
        route: "v1/delegations",
        expectedStatus: 201,
        body: DelegationRequest(
          v: 1,
          challengeId: challenge.id.uuidString.lowercased(),
          challenge: challenge.value,
          installationHandle: installationHandle.uuidString.lowercased(),
          endpointEpoch: Self.endpointEpoch,
          generation: Self.generation,
          relayPubkey: relayPubkey,
          notBefore: notBefore,
          expiresAt: expiresAt,
          assertion: assertion
        )
      )
      guard !response.endpointGrant.isEmpty, response.endpointGrant.utf8.count <= 4_096 else {
        throw BuzzDevPushEnrollmentError.invalidResponse(route: "v1/delegations")
      }
      return response.endpointGrant
    }

    private func fetchCurrentRelayPushPubkey(from relayOrigin: URL) async throws -> String {
      var request = URLRequest(url: relayOrigin)
      request.httpMethod = "GET"
      request.setValue("application/nostr+json", forHTTPHeaderField: "Accept")
      let (data, response) = try await session.data(for: request)
      try Self.expectStatus(response, data: data, route: "NIP-11", expected: 200)
      let document: RelayInformation
      do {
        document = try JSONDecoder().decode(RelayInformation.self, from: data)
      } catch {
        throw BuzzDevPushEnrollmentError.invalidRelayDescriptor
      }
      let current = document.push.keys.filter(\.current)
      guard current.count == 1, Self.isLowercaseHexPubkey(current[0].pubkey) else {
        throw BuzzDevPushEnrollmentError.invalidRelayDescriptor
      }
      return current[0].pubkey
    }

    private func post<Request: Encodable, Response: Decodable>(
      route: String,
      expectedStatus: Int,
      body: Request
    ) async throws -> Response {
      let url = route.split(separator: "/").reduce(gatewayBaseURL) {
        $0.appendingPathComponent(String($1))
      }
      var request = URLRequest(url: url)
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONEncoder().encode(body)
      let (data, response) = try await session.data(for: request)
      try Self.expectStatus(response, data: data, route: route, expected: expectedStatus)
      do {
        return try JSONDecoder().decode(Response.self, from: data)
      } catch {
        throw BuzzDevPushEnrollmentError.invalidResponse(route: route)
      }
    }

    private static func expectStatus(
      _ response: URLResponse,
      data: Data,
      route: String,
      expected: Int
    ) throws {
      guard let http = response as? HTTPURLResponse else {
        throw BuzzDevPushEnrollmentError.invalidResponse(route: route)
      }
      guard http.statusCode == expected else {
        let body = String(decoding: data.prefix(512), as: UTF8.self)
        throw BuzzDevPushEnrollmentError.unexpectedStatus(
          route: route, expected: expected, actual: http.statusCode, body: body
        )
      }
    }

    private static func isHTTPOrigin(_ url: URL) -> Bool {
      (url.scheme == "http" || url.scheme == "https")
        && url.host != nil
        && (url.path.isEmpty || url.path == "/")
        && url.user == nil
        && url.password == nil
        && url.query == nil
        && url.fragment == nil
    }

    private static func relayOrigin(_ url: URL) throws -> (url: URL, text: String) {
      guard url.scheme == "ws" || url.scheme == "wss",
        url.host != nil,
        url.path.isEmpty || url.path == "/",
        url.user == nil,
        url.password == nil,
        url.query == nil,
        url.fragment == nil
      else {
        throw BuzzDevPushEnrollmentError.invalidRelayURL
      }
      var components = URLComponents()
      components.scheme = url.scheme == "wss" ? "https" : "http"
      components.host = url.host
      components.port = url.port
      components.path = "/"
      guard let httpURL = components.url else {
        throw BuzzDevPushEnrollmentError.invalidRelayURL
      }
      var relayComponents = components
      relayComponents.scheme = url.scheme
      guard let relayText = relayComponents.url?.absoluteString else {
        throw BuzzDevPushEnrollmentError.invalidRelayURL
      }
      return (httpURL, relayText)
    }

    private static func isLowercaseHexPubkey(_ value: String) -> Bool {
      value.utf8.count == 64
        && value.utf8.allSatisfy {
          (48...57).contains($0) || (97...102).contains($0)
        }
    }

    private static func isBase64URLChallenge(_ value: String) -> Bool {
      guard value.utf8.count == 43,
        value.utf8.allSatisfy({
          (48...57).contains($0) || (65...90).contains($0)
            || (97...122).contains($0) || $0 == 45 || $0 == 95
        })
      else { return false }
      var padded = value.replacingOccurrences(of: "-", with: "+")
        .replacingOccurrences(of: "_", with: "/")
      padded += String(repeating: "=", count: (4 - padded.count % 4) % 4)
      return Data(base64Encoded: padded)?.count == 32
    }

    private static func lowercaseHex(_ data: Data) -> String {
      data.map { String(format: "%02x", $0) }.joined()
    }
  }

  private struct VersionRequest: Encodable { let v: Int }
  private struct Challenge {
    let id: UUID
    let value: String
  }
  private struct ChallengeResponse: Decodable {
    let challengeId: String
    let challenge: String
    let expiresAt: Int64
    enum CodingKeys: String, CodingKey {
      case challengeId = "challenge_id"
      case challenge
      case expiresAt = "expires_at"
    }
  }
  private struct InstallationRequest: Encodable {
    let v: Int
    let challengeId: String
    let challenge: String
    let keyId: String
    let attestation: String
    let appProfile: String
    let endpoint: String
    let endpointEpoch: Int64
    let expiresAt: Int64
    enum CodingKeys: String, CodingKey {
      case v
      case challengeId = "challenge_id"
      case challenge
      case keyId = "key_id"
      case attestation
      case appProfile = "app_profile"
      case endpoint
      case endpointEpoch = "endpoint_epoch"
      case expiresAt = "expires_at"
    }
  }
  private struct InstallationResponse: Decodable {
    let installationHandle: String
    let endpointEpoch: Int64
    let expiresAt: Int64
    enum CodingKeys: String, CodingKey {
      case installationHandle = "installation_handle"
      case endpointEpoch = "endpoint_epoch"
      case expiresAt = "expires_at"
    }
  }
  private struct DelegationRequest: Encodable {
    let v: Int
    let challengeId: String
    let challenge: String
    let installationHandle: String
    let endpointEpoch: Int64
    let generation: Int64
    let relayPubkey: String
    let notBefore: Int64
    let expiresAt: Int64
    let assertion: String
    enum CodingKeys: String, CodingKey {
      case v
      case challengeId = "challenge_id"
      case challenge
      case installationHandle = "installation_handle"
      case endpointEpoch = "endpoint_epoch"
      case generation
      case relayPubkey = "relay_pubkey"
      case notBefore = "not_before"
      case expiresAt = "expires_at"
      case assertion
    }
  }
  private struct DelegationResponse: Decodable {
    let endpointGrant: String
    enum CodingKeys: String, CodingKey { case endpointGrant = "endpoint_grant" }
  }
  private struct RelayInformation: Decodable {
    struct Push: Decodable {
      struct Key: Decodable {
        let pubkey: String
        let current: Bool
      }
      let keys: [Key]
    }
    let push: Push
  }
#endif
