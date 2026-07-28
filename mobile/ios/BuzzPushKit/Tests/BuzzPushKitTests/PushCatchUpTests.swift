import XCTest

@testable import BuzzPushKit

final class PushCatchUpTests: XCTestCase {
  private let mine = String(repeating: "a", count: 64)
  private let other = String(repeating: "b", count: 64)

  func testSequentialWakesSelectSameSecondSiblingBeforeConsumedDuplicateFallback() {
    let subscription = self.subscription()
    let id0 = String(format: "%064x", 0)
    let id1 = String(format: "%064x", 1)
    let events = [event(id: id0), event(id: id1)]
    var state = PushConsumptionState()

    let first = PushCatchUp.orderedSelections(
      events: events,
      origin: "origin",
      subscriptions: [subscription],
      consumptionState: state,
      verify: { _ in true }
    )
    XCTAssertEqual(first.first?.event.id, id0)
    XCTAssertEqual(first.first?.wasPreviouslyConsumed, false)
    state.consume(PushEventPosition(createdAt: 1_000, id: id0), for: "origin")

    let second = PushCatchUp.orderedSelections(
      events: events,
      origin: "origin",
      subscriptions: [subscription],
      consumptionState: state,
      verify: { _ in true }
    )
    XCTAssertEqual(second.map(\.event.id), [id1, id0])
    XCTAssertEqual(second.map(\.wasPreviouslyConsumed), [false, true])
  }

  func testCompositeSameSecondQueryReachesSuccessorsBeyondFirstRelayPage() {
    let subscription = self.subscription()
    let events = (0..<25).map { event(id: String(format: "%064x", $0)) }
    var state = PushConsumptionState()
    var selected: [String] = []

    while selected.count < events.count {
      let cursor = state.state(for: "origin").cursor
      let filters = PushCatchUp.queryFilters(
        subscriptions: [subscription],
        cursor: cursor,
        limit: 10
      )
      let relayPage = relayResponse(events: events, filters: filters)
      let selection = PushCatchUp.orderedSelections(
        events: relayPage,
        origin: "origin",
        subscriptions: [subscription],
        consumptionState: state,
        verify: { _ in true }
      ).first
      let winner = try! XCTUnwrap(selection)

      XCTAssertFalse(winner.wasPreviouslyConsumed)
      XCTAssertFalse(selected.contains(winner.event.id))
      selected.append(winner.event.id)
      state.consume(
        PushEventPosition(createdAt: winner.event.createdAt, id: winner.event.id),
        for: "origin"
      )
    }

    XCTAssertEqual(selected, events.map(\.id))
  }

  private func subscription() -> PushLeaseSubscription {
    PushLeaseSubscription(
      filter: PushLeaseFilter(kinds: [9], pTags: [mine]),
      notificationClass: "default"
    )
  }

  private func event(id: String) -> VerifiedNostrEvent {
    VerifiedNostrEvent(
      id: id,
      pubkey: other,
      createdAt: 1_000,
      kind: 9,
      tags: [["p", mine]],
      content: "message",
      sig: String(repeating: "c", count: 128)
    )
  }

  private func relayResponse(
    events: [VerifiedNostrEvent],
    filters: [[String: Any]]
  ) -> [VerifiedNostrEvent] {
    var byID: [String: VerifiedNostrEvent] = [:]
    for filter in filters {
      let limit = filter["limit"] as? Int ?? events.count
      let ids = (filter["ids"] as? [String]).map(Set.init)
      let since = filter["since"] as? Int
      let until = filter["until"] as? Int
      let beforeID = filter["before_id"] as? String
      let matches = events.filter { event in
        guard ids?.contains(event.id) ?? true else { return false }
        guard since.map({ event.createdAt >= $0 }) ?? true else { return false }
        if let until, let beforeID {
          return event.createdAt < until
            || (event.createdAt == until && event.id > beforeID)
        }
        return until.map({ event.createdAt <= $0 }) ?? true
      }.sorted {
        $0.createdAt == $1.createdAt ? $0.id < $1.id : $0.createdAt > $1.createdAt
      }.prefix(limit)
      for event in matches {
        byID[event.id] = event
      }
    }
    return Array(byID.values)
  }
}
