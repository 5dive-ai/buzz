import 'package:flutter/foundation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../../shared/relay/relay.dart';
import 'observer_models.dart';
import 'observer_subscription.dart';

const _activeTurnLivenessTimeout = Duration(seconds: 30);
const _activeTurnClockInterval = Duration(seconds: 5);

@immutable
class ActiveAgentTurn {
  final String agentPubkey;
  final String channelId;
  final String turnId;
  final DateTime startedAt;
  final DateTime lastActivityAt;
  final String? triggeringEventId;

  const ActiveAgentTurn({
    required this.agentPubkey,
    required this.channelId,
    required this.turnId,
    required this.startedAt,
    required this.lastActivityAt,
    this.triggeringEventId,
  });

  ActiveAgentTurn copyWith({required DateTime lastActivityAt}) =>
      ActiveAgentTurn(
        agentPubkey: agentPubkey,
        channelId: channelId,
        turnId: turnId,
        startedAt: startedAt,
        lastActivityAt: lastActivityAt,
        triggeringEventId: triggeringEventId,
      );
}

List<ActiveAgentTurn> reduceActiveAgentTurns(
  Map<String, List<ObserverFrame>> framesByAgent, {
  required DateTime now,
}) {
  final activeTurns = <ActiveAgentTurn>[];

  for (final entry in framesByAgent.entries) {
    final agentPubkey = entry.key.toLowerCase();
    final frames = [...entry.value]..sort(_compareFrames);
    final turnsById = <String, ActiveAgentTurn>{};
    final terminalAtById = <String, DateTime>{};

    for (final frame in frames) {
      final frameOrderAt = _frameTimestamp(frame);
      final frameAt = _localFrameTimestamp(frame);
      switch (frame.kind) {
        case 'turn_started':
          final channelId = frame.channelId;
          if (channelId == null) continue;
          final turnId = frame.turnId ?? 'seq-${frame.seq}';
          final startedAt = _safeStartedAt(frame, frameAt);
          turnsById[turnId] = ActiveAgentTurn(
            agentPubkey: agentPubkey,
            channelId: channelId,
            turnId: turnId,
            startedAt: startedAt,
            lastActivityAt: frameAt,
            triggeringEventId: _triggeringEventId(frame.payload),
          );
        case 'turn_completed':
        case 'turn_error':
        case 'agent_panic':
          final turnId = frame.turnId;
          if (turnId != null) {
            terminalAtById[turnId] = frameOrderAt;
            turnsById.remove(turnId);
            continue;
          }
          final channelId = frame.channelId;
          if (channelId == null) continue;
          final matchingTurn = turnsById.values
              .where((turn) => turn.channelId == channelId)
              .firstOrNull;
          if (matchingTurn != null) {
            terminalAtById[matchingTurn.turnId] = frameOrderAt;
            turnsById.remove(matchingTurn.turnId);
          }
        case 'acp_read':
        case 'acp_write':
        case 'turn_liveness':
          final turnId = frame.turnId;
          if (turnId == null) continue;
          final activeTurn = turnsById[turnId];
          if (activeTurn != null) {
            turnsById[turnId] = activeTurn.copyWith(lastActivityAt: frameAt);
            continue;
          }

          final channelId = frame.channelId;
          if (channelId == null) continue;
          final terminalAt = terminalAtById[turnId];
          if (terminalAt != null && !frameOrderAt.isAfter(terminalAt)) continue;
          turnsById[turnId] = ActiveAgentTurn(
            agentPubkey: agentPubkey,
            channelId: channelId,
            turnId: turnId,
            startedAt: _safeStartedAt(frame, frameAt),
            lastActivityAt: frameAt,
          );
      }
    }

    activeTurns.addAll(
      turnsById.values.where(
        (turn) => !turn.lastActivityAt.isBefore(
          now.subtract(_activeTurnLivenessTimeout),
        ),
      ),
    );
  }

  activeTurns.sort((a, b) {
    final started = a.startedAt.compareTo(b.startedAt);
    if (started != 0) return started;
    final agent = a.agentPubkey.compareTo(b.agentPubkey);
    if (agent != 0) return agent;
    return a.turnId.compareTo(b.turnId);
  });
  return List.unmodifiable(activeTurns);
}

final _activeAgentTurnClockProvider = StreamProvider<DateTime>((ref) async* {
  yield DateTime.now().toUtc();
  yield* Stream<DateTime>.periodic(
    _activeTurnClockInterval,
    (_) => DateTime.now().toUtc(),
  );
});

final activeAgentTurnsProvider = Provider<List<ActiveAgentTurn>>((ref) {
  final observerState = ref.watch(observerRelayProvider);
  ref.watch(appLifecycleProvider);
  final now =
      ref.watch(_activeAgentTurnClockProvider).value ?? DateTime.now().toUtc();
  return reduceActiveAgentTurns(observerState.framesByAgent, now: now);
});

DateTime _frameTimestamp(ObserverFrame frame) =>
    DateTime.tryParse(frame.timestamp) ??
    DateTime.fromMillisecondsSinceEpoch(frame.seq);

DateTime _localFrameTimestamp(ObserverFrame frame) =>
    frame.receivedAt ?? _frameTimestamp(frame);

DateTime _safeStartedAt(ObserverFrame frame, DateTime frameAt) {
  final hostFrameAt = DateTime.tryParse(frame.timestamp);
  final hostStartedAt = DateTime.tryParse(frame.startedAt ?? '');
  if (hostFrameAt == null ||
      hostStartedAt == null ||
      hostStartedAt.isAfter(hostFrameAt)) {
    return frameAt;
  }
  return frameAt.subtract(hostFrameAt.difference(hostStartedAt));
}

String? _triggeringEventId(dynamic payload) {
  if (payload is! Map) return null;
  final eventIds = payload['triggeringEventIds'];
  if (eventIds is! List) return null;
  for (final eventId in eventIds) {
    if (eventId is String && eventId.isNotEmpty) return eventId;
  }
  return null;
}

int _compareFrames(ObserverFrame a, ObserverFrame b) {
  final timestamp = _frameTimestamp(a).compareTo(_frameTimestamp(b));
  return timestamp != 0 ? timestamp : a.seq.compareTo(b.seq);
}
