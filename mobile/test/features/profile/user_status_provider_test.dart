import 'package:buzz/features/profile/user_status_cache_provider.dart';
import 'package:buzz/features/profile/user_status.dart';
import 'package:buzz/features/profile/user_status_provider.dart';
import 'package:buzz/shared/relay/relay.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:nostr/nostr.dart' as nostr;

void main() {
  test(
    'publishes the selected status expiration on the final signed event',
    () async {
      final keys = nostr.Keys.generate();
      final relaySession = _RecordingRelaySession();
      final expiresAt = DateTime.fromMillisecondsSinceEpoch(
        1_900_000_000 * 1000,
      );
      final container = ProviderContainer(
        overrides: [
          relayConfigProvider.overrideWith(
            () => _FixedRelayConfigNotifier(keys.nsec),
          ),
          relaySessionProvider.overrideWith(() => relaySession),
          userStatusCacheProvider.overrideWith(_EmptyUserStatusCache.new),
        ],
      );
      addTearDown(container.dispose);

      await container.read(userStatusProvider.future);
      await container
          .read(userStatusProvider.notifier)
          .setStatus(' Focusing ', '\u{1F3AF}', expiresAt: expiresAt);

      final event = relaySession.published.single;
      expect(event.kind, EventKind.userStatus);
      expect(event.content, 'Focusing');
      expect(event.tags, contains(equals(['d', 'general'])));
      expect(event.tags, contains(equals(['emoji', '\u{1F3AF}'])));
      expect(event.tags, contains(equals(['expiration', '1900000000'])));
    },
  );
}

class _FixedRelayConfigNotifier extends RelayConfigNotifier {
  _FixedRelayConfigNotifier(this.nsec);

  final String nsec;

  @override
  RelayConfig build() =>
      RelayConfig(baseUrl: 'https://relay.example', nsec: nsec);
}

class _RecordingRelaySession extends RelaySessionNotifier {
  final List<NostrEvent> published = [];

  @override
  SessionState build() => const SessionState(status: SessionStatus.connected);

  @override
  Future<List<NostrEvent>> fetchHistory(
    NostrFilter filter, {
    Duration timeout = const Duration(seconds: 8),
  }) async => [];

  @override
  Future<NostrEvent> publish(
    NostrEvent event, {
    Duration timeout = const Duration(seconds: 8),
  }) async {
    published.add(event);
    return event;
  }
}

class _EmptyUserStatusCache extends UserStatusCacheNotifier {
  @override
  Map<String, UserStatus?> build() => {};
}
