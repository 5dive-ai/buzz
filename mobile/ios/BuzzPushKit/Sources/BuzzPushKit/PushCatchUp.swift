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
  /// Build catch-up filters that preserve the lease's constraints. The broad
  /// timestamp filter finds newer events, while composite pages cover every gap
  /// in the active second's exact delivered-ID set. A separate exact-id filter
  /// keeps the last displayed event available only for duplicate cleanup.
  public static func queryFilters(
    subscriptions: [PushLeaseSubscription],
    cursor: PushEventPosition?,
    delivered: [PushEventPosition],
    lastDisplayed: PushEventPosition?,
    limit: Int
  ) -> [[String: Any]] {
    subscriptions.flatMap { subscription in
      var filters: [[String: Any]] = []
      if let cursor {
        // `+ 1` is safe only as the strictly-later half of this pair. The
        // active-second filters below start at the bottom and drain same-second
        // rows without making event-ID ordering the dedupe authority.
        if cursor.createdAt < Int.max {
          filters.append(
            subscription.filter.queryFilter(
              since: cursor.createdAt + 1,
              limit: limit
            )
          )
        }

        var activeHead = subscription.filter.queryFilter(
          since: cursor.createdAt,
          limit: limit
        )
        activeHead["until"] = cursor.createdAt
        filters.append(activeHead)

        let activeDelivered = delivered
          .filter { $0.createdAt == cursor.createdAt }
          .sorted()
        for boundaryIndex in stride(
          from: limit - 1,
          to: activeDelivered.count,
          by: limit
        ) {
          var page = subscription.filter.queryFilter(
            since: cursor.createdAt,
            limit: limit
          )
          page["until"] = cursor.createdAt
          page["before_id"] = activeDelivered[boundaryIndex].id
          filters.append(page)
        }
      } else {
        filters.append(subscription.filter.queryFilter(since: nil, limit: limit))
      }

      if let lastDisplayed {
        var duplicateFallback = subscription.filter.queryFilter(since: nil, limit: 1)
        duplicateFallback["ids"] = [lastDisplayed.id]
        filters.append(duplicateFallback)
      }
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
    let duplicateFallbackID = consumptionState.state(for: origin).lastDisplayed?.id
    let duplicates = ordered.compactMap { event -> PushCatchUpSelection? in
      guard event.id == duplicateFallbackID,
        consumptionState.hasConsumed(eventID: event.id, for: origin)
      else {
        return nil
      }
      return PushCatchUpSelection(event: event, wasPreviouslyConsumed: true)
    }
    return selectable + duplicates
  }
}
