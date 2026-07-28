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
        var userInfo = content.userInfo
        userInfo[PushNotificationIdentity.userInfoKey] = resolution.identity.userInfoValue
        content.userInfo = userInfo
        do {
          _ = try PushNotificationIdentity.require(from: content.userInfo)
        } catch {
          content.title = "Buzz notification needs attention"
          content.body = "Buzz could not persist notification identity."
          content.subtitle = ""
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
  let identity: PushNotificationIdentity
}

enum BuzzPushResolutionResult {
  case notification(BuzzPushResolution)
  case diagnostic(String)
  case none
}

protocol BuzzPushNotificationResolving {
  func resolve(completion: @escaping (BuzzPushResolutionResult) -> Void)
}

protocol BuzzDeliveredNotificationManaging {
  func deliveredNotifications(completion: @escaping ([UNNotification]) -> Void)
  func removeDeliveredNotifications(withIdentifiers identifiers: [String])
}

extension UNUserNotificationCenter: BuzzDeliveredNotificationManaging {
  func deliveredNotifications(completion: @escaping ([UNNotification]) -> Void) {
    getDeliveredNotifications(completionHandler: completion)
  }
}

final class BuzzPushNotificationResolver: BuzzPushNotificationResolving {
  private struct Candidate {
    let resolution: BuzzPushResolution
    let event: VerifiedNostrEvent
    let community: PushLeaseCommunity
    let wasPreviouslyConsumed: Bool
  }

  private let session: URLSession
  private let appGroupIdentifier: String?
  private let keychainAccessGroup: String?
  private let notificationCenter: BuzzDeliveredNotificationManaging
  private let fileManager: FileManager

  init(
    session: URLSession = .shared,
    appGroupIdentifier: String? = Bundle.main.object(
      forInfoDictionaryKey: "BuzzAppGroupIdentifier"
    ) as? String,
    keychainAccessGroup: String? = Bundle.main.object(
      forInfoDictionaryKey: "BuzzKeychainAccessGroup"
    ) as? String,
    notificationCenter: BuzzDeliveredNotificationManaging =
      UNUserNotificationCenter.current(),
    fileManager: FileManager = .default
  ) {
    self.session = session
    self.appGroupIdentifier = appGroupIdentifier
    self.keychainAccessGroup = keychainAccessGroup
    self.notificationCenter = notificationCenter
    self.fileManager = fileManager
  }

  func resolve(completion: @escaping (BuzzPushResolutionResult) -> Void) {
    let loaded: (communities: [PushLeaseCommunity], store: PushConsumptionStateStore)
    do {
      loaded = try loadState()
    } catch {
      completion(.diagnostic("Open Buzz to refresh notification subscriptions."))
      return
    }

    let communities = loaded.communities.filter {
      $0.pubkey?.isEmpty == false && loadPrivateKey(communityID: $0.id) != nil
    }
    guard !communities.isEmpty else {
      completion(.diagnostic("Open Buzz to restore notification credentials."))
      return
    }

    let consumptionState: PushConsumptionState
    do {
      consumptionState = try loaded.store.read()
    } catch {
      completion(.diagnostic("Buzz could not read notification history."))
      return
    }

    let group = DispatchGroup()
    let lock = NSLock()
    var candidates: [Candidate] = []
    var diagnostics: [String] = []
    for community in communities {
      group.enter()
      query(community, consumptionState: consumptionState) { result in
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
        if lhs.wasPreviouslyConsumed != rhs.wasPreviouslyConsumed {
          return !lhs.wasPreviouslyConsumed
        }
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

      let position = PushEventPosition(
        createdAt: winner.event.createdAt,
        id: winner.event.id
      )
      var shouldPresent = winner.wasPreviouslyConsumed
      do {
        try loaded.store.update { state in
          state.removeInactiveOrigins(Set(communities.map(\.id)))
          if state.hasConsumed(eventID: position.id, for: winner.community.id) {
            shouldPresent = true
            return
          }
          guard state.canSelect(position, for: winner.community.id) else { return }
          state.consume(position, for: winner.community.id)
          shouldPresent = true
        }
      } catch {
        completion(.diagnostic("Buzz could not save notification history."))
        return
      }
      guard shouldPresent else {
        completion(.none)
        return
      }
      absorbSequentialDuplicate(of: winner.resolution, completion: completion)
    }
  }

  private enum QueryResult {
    case candidate(Candidate)
    case diagnostic(String)
    case none
  }

  private func query(
    _ community: PushLeaseCommunity,
    consumptionState: PushConsumptionState,
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
    let cursor = consumptionState.state(for: community.id).cursor
    let filters = PushCatchUp.queryFilters(
      subscriptions: subscriptions,
      cursor: cursor,
      limit: 10
    )
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
          subscriptions: subscriptions,
          consumptionState: consumptionState
        )
      )
    }.resume()
  }

  private static func decodeResolution(
    events: [VerifiedNostrEvent],
    community: PushLeaseCommunity,
    subscriptions: [PushLeaseSubscription],
    consumptionState: PushConsumptionState
  ) -> QueryResult {
    let matching = PushCatchUp.orderedSelections(
      events: events,
      origin: community.id,
      subscriptions: subscriptions,
      consumptionState: consumptionState
    )

    for selection in matching {
      let event = selection.event
      let identity = PushNotificationIdentity(eventID: event.id, origin: community.id)
      let resolution: BuzzPushResolution
      if event.kind == 9 {
        let body = previewBody(event.content)
        guard !body.isEmpty else { continue }
        let channel = event.tags.first { $0.count >= 2 && $0[0] == "h" }?[1]
        resolution = BuzzPushResolution(
          title: shortPubkey(event.pubkey),
          body: body,
          subtitle: community.name,
          threadIdentifier: channel ?? community.id,
          identity: identity
        )
      } else {
        // This extension renders kind 9 only. Other lease-authorized wake kinds
        // stay selectable so issue 10's catch-up sets remain aligned, but use
        // neutral activity copy until kind-aware rendering lands in issue 20.
        let channel = event.tags.first { $0.count >= 2 && $0[0] == "h" }?[1]
        resolution = BuzzPushResolution(
          title: community.name,
          body: "Open Buzz to view your new activity.",
          subtitle: nil,
          threadIdentifier: channel ?? community.id,
          identity: identity
        )
      }
      return .candidate(
        Candidate(
          resolution: resolution,
          event: event,
          community: community,
          wasPreviouslyConsumed: selection.wasPreviouslyConsumed
        )
      )
    }
    return .none
  }

  private func absorbSequentialDuplicate(
    of resolution: BuzzPushResolution,
    completion: @escaping (BuzzPushResolutionResult) -> Void
  ) {
    notificationCenter.deliveredNotifications { [weak self] notifications in
      guard let self else { return }
      let records = notifications.map {
        PushDeliveredNotificationRecord(
          requestIdentifier: $0.request.identifier,
          userInfo: $0.request.content.userInfo
        )
      }
      let requestIdentifiers: [String]
      do {
        requestIdentifiers = try PushDuplicateAbsorption.requestIdentifiersToRemove(
          matching: resolution.identity,
          from: records
        )
      } catch {
        completion(.diagnostic("Buzz could not inspect notification identity."))
        return
      }
      if !requestIdentifiers.isEmpty {
        self.notificationCenter.removeDeliveredNotifications(
          withIdentifiers: requestIdentifiers
        )
      }

      // Limitation 1: A duplicate wake can still alert before the older copy is
      // removed. The stack stops growing; the user can still be notified twice
      // for one event.
      // Limitation 2: Two concurrent NSE invocations can each miss the other's
      // delivered notification and both leave a copy. Sequential duplicates are
      // absorbed; truly concurrent delivery still races. Exact absorption needs
      // gateway-side apns-collapse-id, which is issue 18 and out of scope.
      completion(.notification(resolution))
    }
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

  private func loadState() throws -> (
    communities: [PushLeaseCommunity],
    store: PushConsumptionStateStore
  ) {
    guard let appGroupIdentifier,
      let container = fileManager.containerURL(
        forSecurityApplicationGroupIdentifier: appGroupIdentifier
      )
    else {
      throw CocoaError(.fileNoSuchFile)
    }
    let snapshotURL = container.appendingPathComponent("push-communities.json")
    let data = try Data(contentsOf: snapshotURL)
    let snapshot = try JSONDecoder().decode(PushLeaseSnapshot.self, from: data)
    return (snapshot.communities, PushConsumptionStateStore(containerURL: container))
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
