import BuzzPushKit
import Foundation
import Security
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var bestAttemptContent: UNMutableNotificationContent?
  private var resolver: BuzzPushNotificationResolving = BuzzPushNotificationResolver()

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
      contentHandler(request.content)
      return
    }
    bestAttemptContent = content

    resolver.resolve { [weak self] result in
      guard let self else { return }
      switch result {
      case .notification(let resolution):
        content.title = resolution.title
        content.body = resolution.body
        content.subtitle = resolution.subtitle ?? ""
        if let threadIdentifier = resolution.threadIdentifier {
          content.threadIdentifier = threadIdentifier
        }
      case .diagnostic(let message):
        content.title = "Buzz notification needs attention"
        content.body = message
        content.subtitle = ""
        content.threadIdentifier = "buzz.push.diagnostic"
      case .none:
        break
      }
      self.finish(content)
    }
  }

  override func serviceExtensionTimeWillExpire() {
    if let bestAttemptContent { finish(bestAttemptContent) }
  }

  private func finish(_ content: UNNotificationContent) {
    guard let contentHandler else { return }
    self.contentHandler = nil
    contentHandler(content)
  }
}

struct BuzzPushResolution {
  let title: String
  let body: String
  let subtitle: String?
  let threadIdentifier: String?
}

enum BuzzPushResolutionResult {
  case notification(BuzzPushResolution)
  case diagnostic(String)
  case none
}

protocol BuzzPushNotificationResolving {
  func resolve(completion: @escaping (BuzzPushResolutionResult) -> Void)
}

final class BuzzPushNotificationResolver: BuzzPushNotificationResolving {
  private struct Candidate {
    let resolution: BuzzPushResolution
    let event: VerifiedNostrEvent
    let community: PushLeaseCommunity
  }

  private let session: URLSession
  private let appGroupIdentifier: String?
  private let keychainAccessGroup: String?
  private let defaults: UserDefaults?
  private let fileManager: FileManager

  init(
    session: URLSession = .shared,
    appGroupIdentifier: String? = Bundle.main.object(
      forInfoDictionaryKey: "BuzzAppGroupIdentifier"
    ) as? String,
    keychainAccessGroup: String? = Bundle.main.object(
      forInfoDictionaryKey: "BuzzKeychainAccessGroup"
    ) as? String,
    fileManager: FileManager = .default
  ) {
    self.session = session
    self.appGroupIdentifier = appGroupIdentifier
    self.keychainAccessGroup = keychainAccessGroup
    defaults = appGroupIdentifier.flatMap(UserDefaults.init(suiteName:))
    self.fileManager = fileManager
  }

  func resolve(completion: @escaping (BuzzPushResolutionResult) -> Void) {
    let loadedCommunities: [PushLeaseCommunity]
    do {
      loadedCommunities = try loadCommunities()
    } catch {
      completion(.diagnostic("Open Buzz to refresh notification subscriptions."))
      return
    }
    removeStaleWatermarks(activeCommunityIDs: Set(loadedCommunities.map(\.id)))
    let communities = loadedCommunities.filter {
      $0.pubkey?.isEmpty == false && loadPrivateKey(communityID: $0.id) != nil
    }
    guard !communities.isEmpty else {
      completion(.diagnostic("Open Buzz to restore notification credentials."))
      return
    }

    let group = DispatchGroup()
    let lock = NSLock()
    var candidates: [Candidate] = []
    var diagnostics: [String] = []
    for community in communities {
      group.enter()
      query(community) { result in
        lock.lock()
        switch result {
        case .candidate(let candidate): candidates.append(candidate)
        case .diagnostic(let diagnostic): diagnostics.append(diagnostic)
        case .none: break
        }
        lock.unlock()
        group.leave()
      }
    }
    group.notify(queue: .global(qos: .userInitiated)) { [weak self] in
      guard let self else { return }
      let sorted = candidates.sorted { lhs, rhs in
        if lhs.event.createdAt != rhs.event.createdAt {
          return lhs.event.createdAt > rhs.event.createdAt
        }
        if lhs.event.id != rhs.event.id { return lhs.event.id < rhs.event.id }
        return lhs.community.id < rhs.community.id
      }
      guard let winner = sorted.first else {
        completion(diagnostics.sorted().first.map(BuzzPushResolutionResult.diagnostic) ?? .none)
        return
      }
      for candidate in candidates {
        self.defaults?.set(
          PushWatermark.persistedTimestamp(eventTimestamp: candidate.event.createdAt),
          forKey: PushWatermark.key(communityID: candidate.community.id)
        )
      }
      completion(.notification(winner.resolution))
    }
  }

  private enum QueryResult {
    case candidate(Candidate)
    case diagnostic(String)
    case none
  }

  private func query(
    _ community: PushLeaseCommunity,
    completion: @escaping (QueryResult) -> Void
  ) {
    guard let privateKey = loadPrivateKey(communityID: community.id) else {
      completion(.diagnostic("Open Buzz to restore notification credentials."))
      return
    }
    let subscriptions: [PushLeaseSubscription]
    do {
      subscriptions = try community.pushSubscriptionState.authoritativeSubscriptions()
    } catch {
      completion(.diagnostic("Open Buzz to refresh notification subscriptions."))
      return
    }
    let watermarkKey = PushWatermark.key(communityID: community.id)
    let storedWatermark = defaults?.integer(forKey: watermarkKey) ?? 0
    let watermark = PushWatermark.queryTimestamp(storedWatermark: storedWatermark)
    if watermark != storedWatermark { defaults?.set(watermark, forKey: watermarkKey) }
    let since = PushWatermark.querySince(watermark: watermark)
    let filters = subscriptions.map { $0.filter.queryFilter(since: since, limit: 10) }
    guard let body = try? JSONSerialization.data(withJSONObject: filters) else {
      completion(.diagnostic("Buzz notification subscriptions are invalid."))
      return
    }
    guard let relayURL = community.relayURL,
      let url = URL(string: "/query", relativeTo: relayURL)
    else {
      completion(.diagnostic("Buzz notification relay URL is invalid."))
      return
    }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.httpBody = body
    request.timeoutInterval = 8
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    guard
      let auth = try? NostrHTTPAuth.authorizationHeader(
        url: url,
        method: "POST",
        body: body,
        privateKeyHex: privateKey
      )
    else {
      completion(.diagnostic("Buzz could not authenticate notification catch-up."))
      return
    }
    request.setValue(auth, forHTTPHeaderField: "Authorization")
    session.dataTask(with: request) { data, response, _ in
      guard let response = response as? HTTPURLResponse,
        (200..<300).contains(response.statusCode),
        let data,
        let events = try? JSONDecoder().decode([VerifiedNostrEvent].self, from: data)
      else {
        completion(.none)
        return
      }
      completion(
        Self.decodeResolution(
          events: events,
          community: community,
          subscriptions: subscriptions
        )
      )
    }.resume()
  }

  private static func decodeResolution(
    events: [VerifiedNostrEvent],
    community: PushLeaseCommunity,
    subscriptions: [PushLeaseSubscription]
  ) -> QueryResult {
    let matching = events.filter { event in
      event.hasValidIDAndSignature()
        && PushWatermark.isAcceptable(eventTimestamp: event.createdAt)
        && subscriptions.contains(where: {
          PushLeaseMatcher.matches(event: event, subscription: $0)
        })
    }.sorted {
      $0.createdAt == $1.createdAt ? $0.id < $1.id : $0.createdAt > $1.createdAt
    }

    for event in matching {
      let resolution: BuzzPushResolution
      if event.kind == 9 {
        let body = previewBody(event.content)
        guard !body.isEmpty else { continue }
        let channel = event.tags.first { $0.count >= 2 && $0[0] == "h" }?[1]
        resolution = BuzzPushResolution(
          title: shortPubkey(event.pubkey),
          body: body,
          subtitle: community.name,
          threadIdentifier: channel ?? community.id
        )
      } else {
        // Wake-only kinds are fetched from the authoritative lease, but this
        // extension cannot render them yet.
        resolution = BuzzPushResolution(
          title: "Buzz notification needs attention",
          body: "Buzz received a kind \(event.kind) wake that this app version cannot display.",
          subtitle: community.name,
          threadIdentifier: "buzz.push.unsupported-kind.\(event.kind)"
        )
      }
      return .candidate(Candidate(resolution: resolution, event: event, community: community))
    }
    return .none
  }

  private static func previewBody(_ content: String) -> String {
    var result = content.replacingOccurrences(
      of: #"```[\s\S]*?```"#,
      with: "[code]",
      options: .regularExpression
    )
    result = result.replacingOccurrences(
      of: #"`([^`]*)`"#,
      with: "$1",
      options: .regularExpression
    )
    result = result.replacingOccurrences(
      of: #"!?\[([^\]]*)\]\([^)]*\)"#,
      with: "$1",
      options: .regularExpression
    )
    result = result.replacingOccurrences(
      of: #"https?://\S+"#,
      with: "[link]",
      options: .regularExpression
    )
    result = result.replacingOccurrences(
      of: #"\s+"#,
      with: " ",
      options: .regularExpression
    ).trimmingCharacters(in: .whitespacesAndNewlines)
    return result.count > 180
      ? String(result.prefix(177)).trimmingCharacters(in: .whitespacesAndNewlines) + "…"
      : result
  }

  private static func shortPubkey(_ pubkey: String) -> String {
    pubkey.count > 8 ? String(pubkey.prefix(8)) + "…" : pubkey
  }

  private func removeStaleWatermarks(activeCommunityIDs: Set<String>) {
    guard let defaults else { return }
    for key in PushWatermark.staleKeys(
      in: Array(defaults.dictionaryRepresentation().keys),
      activeCommunityIDs: activeCommunityIDs
    ) {
      defaults.removeObject(forKey: key)
    }
  }

  private func loadPrivateKey(communityID: String) -> String? {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "buzz.push.nse.signing",
      kSecAttrAccount as String: communityID,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    if let keychainAccessGroup, !keychainAccessGroup.isEmpty {
      query[kSecAttrAccessGroup as String] = keychainAccessGroup
    }
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
      let data = item as? Data
    else { return nil }
    return String(data: data, encoding: .utf8)
  }

  private func loadCommunities() throws -> [PushLeaseCommunity] {
    guard let appGroupIdentifier,
      let container = fileManager.containerURL(
        forSecurityApplicationGroupIdentifier: appGroupIdentifier
      )
    else {
      throw CocoaError(.fileNoSuchFile)
    }
    let snapshotURL = container.appendingPathComponent("push-communities.json")
    let data = try Data(contentsOf: snapshotURL)
    return try JSONDecoder().decode(PushLeaseSnapshot.self, from: data).communities
  }
}

extension PushLeaseCommunity {
  fileprivate var relayURL: URL? {
    guard let url = URL(string: relayUrl),
      let scheme = url.scheme?.lowercased(),
      scheme == "https" || scheme == "http"
    else {
      return nil
    }
    return url
  }
}
