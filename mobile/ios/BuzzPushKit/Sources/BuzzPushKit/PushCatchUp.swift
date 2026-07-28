import Foundation

public struct PushCatchUpSelection: Sendable {
  public let event: VerifiedNostrEvent
  public let wasPreviouslyConsumed: Bool

  public init(event: VerifiedNostrEvent, wasPreviouslyConsumed: Bool) {
    self.event = event
    self.wasPreviouslyConsumed = wasPreviouslyConsumed
  }
}

public enum PushCatchUp {
  /// Build catch-up filters that preserve the lease's constraints while moving
  /// strictly beyond a composite cursor. A second, exact-id filter keeps the
  /// current cursor event available only as a duplicate-cleanup fallback.
  public static func queryFilters(
    subscriptions: [PushLeaseSubscription],
    cursor: PushEventPosition?,
    limit: Int
  ) -> [[String: Any]] {
    subscriptions.flatMap { subscription in
      guard let cursor else {
        return [subscription.filter.queryFilter(since: nil, limit: limit)]
      }

      var filters: [[String: Any]] = []
      if cursor.createdAt < Int.max {
        filters.append(
          subscription.filter.queryFilter(
            since: cursor.createdAt + 1,
            limit: limit
          )
        )
      }

      var sameSecond = subscription.filter.queryFilter(
        since: cursor.createdAt,
        limit: limit
      )
      sameSecond["until"] = cursor.createdAt
      sameSecond["before_id"] = cursor.id
      filters.append(sameSecond)

      var duplicateFallback = subscription.filter.queryFilter(since: nil, limit: 1)
      duplicateFallback["ids"] = [cursor.id]
      filters.append(duplicateFallback)
      return filters
    }
  }

  /// Return selectable events first and consumed duplicate fallbacks last.
  /// Duplicate cleanup therefore never competes with forward progress.
  public static func orderedSelections(
    events: [VerifiedNostrEvent],
    origin: String,
    subscriptions: [PushLeaseSubscription],
    consumptionState: PushConsumptionState,
    verify: (VerifiedNostrEvent) -> Bool = { $0.hasValidIDAndSignature() }
  ) -> [PushCatchUpSelection] {
    var eventsByID: [String: VerifiedNostrEvent] = [:]
    for event in events where verify(event) {
      guard subscriptions.contains(where: {
        PushLeaseMatcher.matches(event: event, subscription: $0)
      }) else {
        continue
      }
      eventsByID[event.id] = event
    }

    let ordered = eventsByID.values.sorted {
      $0.createdAt == $1.createdAt ? $0.id < $1.id : $0.createdAt > $1.createdAt
    }
    let selectable = ordered.compactMap { event -> PushCatchUpSelection? in
      let position = PushEventPosition(createdAt: event.createdAt, id: event.id)
      guard consumptionState.canSelect(position, for: origin) else { return nil }
      return PushCatchUpSelection(event: event, wasPreviouslyConsumed: false)
    }
    let duplicates = ordered.compactMap { event -> PushCatchUpSelection? in
      guard consumptionState.hasConsumed(eventID: event.id, for: origin) else { return nil }
      return PushCatchUpSelection(event: event, wasPreviouslyConsumed: true)
    }
    return selectable + duplicates
  }
}
