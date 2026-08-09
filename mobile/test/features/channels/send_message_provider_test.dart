import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:nostr/nostr.dart' as nostr;
import 'package:buzz/features/channels/channel.dart';
import 'package:buzz/features/channels/channel_management_provider.dart';
import 'package:buzz/features/channels/send_message_provider.dart';
import 'package:buzz/features/profile/user_profile.dart';
import 'package:buzz/shared/relay/relay.dart';

void main() {
  test(
    'adds the signed message locally before relay acknowledgement',
    () async {
      final session = _PendingPublishRelaySession();
      final localMessages = <NostrEvent>[];
      final removedIds = <String>[];
      final completedIds = <String>[];
      final send = SendMessage(
        signedEventRelay: SignedEventRelay(
          session: session,
          nsec: nostr.Keys.generate().nsec,
        ),
        fetchMembers: (_) async => const [],
        fetchDirectoryAgentPubkeys: () async => const {},
        readUserCache: () => const {},
        addLocalMessage: (_, event) => localMessages.add(event),
        completeLocalMessage: (_, eventId) => completedIds.add(eventId),
        removeLocalMessage: (_, eventId) => removedIds.add(eventId),
      );

      final result = send(channelId: _channelId, content: 'hello');
      await session.published;

      expect(localMessages, hasLength(1));
      expect(localMessages.single.id, session.event.id);
      expect(localMessages.single.content, 'hello');
      expect(localMessages.single.channelId, _channelId);
      expect(removedIds, isEmpty);

      session.accept();
      await result;
      expect(completedIds, [localMessages.single.id]);
      expect(removedIds, isEmpty);
    },
  );

  test('rolls back the signed local message when publish fails', () async {
    final session = _PendingPublishRelaySession();
    final localMessages = <NostrEvent>[];
    final completedIds = <String>[];
    final removedIds = <String>[];
    final send = SendMessage(
      signedEventRelay: SignedEventRelay(
        session: session,
        nsec: nostr.Keys.generate().nsec,
      ),
      fetchMembers: (_) async => const [],
      fetchDirectoryAgentPubkeys: () async => const {},
      readUserCache: () => const {},
      addLocalMessage: (_, event) => localMessages.add(event),
      completeLocalMessage: (_, eventId) => completedIds.add(eventId),
      removeLocalMessage: (_, eventId) => removedIds.add(eventId),
    );

    final result = send(channelId: _channelId, content: 'hello');
    await session.published;
    session.reject();

    await expectLater(result, throwsException);
    expect(completedIds, isEmpty);
    expect(removedIds, [localMessages.single.id]);
  });

  test('final signed event addresses the current DM agent member', () async {
    final session = _PendingPublishRelaySession();
    final signingKey = nostr.Keys.generate().nsec;
    final sender = nostr.Keys(
      nostr.Nip19.decode(payload: signingKey).data,
    ).public;
    final staleAgent = 'a' * 64;
    final activeAgent = 'c' * 64;
    final human = 'b' * 64;
    final send = SendMessage(
      signedEventRelay: SignedEventRelay(session: session, nsec: signingKey),
      fetchMembers: (_) async => [_member(sender), _member(activeAgent)],
      fetchDirectoryAgentPubkeys: () async {
        // This awaited lookup reproduces the cold-DM path where the widget's
        // synchronous FutureProvider snapshot has not loaded yet.
        await Future<void>.delayed(Duration.zero);
        return {staleAgent};
      },
      // Managed agents are also identified by their verified NIP-OA owner,
      // even when a membership snapshot labels them as an ordinary member and
      // the relay agent directory has not caught up yet.
      readUserCache: () => {
        activeAgent: UserProfile(pubkey: activeAgent, ownerPubkey: sender),
      },
      addLocalMessage: (_, _) {},
      completeLocalMessage: (_, _) {},
      removeLocalMessage: (_, _) {},
    );

    final result = send(
      channelId: _channelId,
      content: 'hello without a visible mention',
      // Metadata still names the replaced agent. Delivery must follow the
      // authoritative current membership snapshot instead.
      channel: _dmChannel([sender, staleAgent, human]),
      mentionPubkeys: const [],
    );
    await session.published;

    expect(session.event.content, 'hello without a visible mention');
    expect(session.event.tags.where((tag) => tag.first == 'p').toList(), [
      ['p', activeAgent],
    ]);

    session.accept();
    await result;
  });

  test('final signed event does not implicitly address a human DM', () async {
    final session = _PendingPublishRelaySession();
    final signingKey = nostr.Keys.generate().nsec;
    final sender = nostr.Keys(
      nostr.Nip19.decode(payload: signingKey).data,
    ).public;
    final human = 'b' * 64;
    final send = SendMessage(
      signedEventRelay: SignedEventRelay(session: session, nsec: signingKey),
      fetchMembers: (_) async => [_member(sender), _member(human)],
      fetchDirectoryAgentPubkeys: () async => const {},
      readUserCache: () => const {},
      addLocalMessage: (_, _) {},
      completeLocalMessage: (_, _) {},
      removeLocalMessage: (_, _) {},
    );

    final result = send(
      channelId: _channelId,
      content: 'hello human',
      channel: _dmChannel([sender, human]),
      mentionPubkeys: const [],
    );
    await session.published;

    expect(session.event.tags.where((tag) => tag.first == 'p'), isEmpty);

    session.accept();
    await result;
  });

  test('cancels delivery after the active community changes', () async {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    container
        .read(relayConfigProvider.notifier)
        .update(baseUrl: 'https://first.example');
    final send = container.read(sendMessageProvider);

    container
        .read(relayConfigProvider.notifier)
        .update(baseUrl: 'https://second.example');

    await expectLater(
      send(channelId: _channelId, content: 'old community draft'),
      throwsA(
        isA<StateError>().having(
          (error) => error.message,
          'message',
          contains('active community changed'),
        ),
      ),
    );
  });
}

const _channelId = '11111111-1111-4111-8111-111111111111';

Channel _dmChannel(List<String> participantPubkeys) => Channel(
  id: _channelId,
  name: 'DM',
  channelType: 'dm',
  visibility: 'private',
  description: '',
  createdBy: participantPubkeys.first,
  createdAt: DateTime(2025),
  memberCount: participantPubkeys.length,
  participantPubkeys: participantPubkeys,
  isMember: true,
);

ChannelMember _member(String pubkey, {String role = 'member'}) =>
    ChannelMember(pubkey: pubkey, role: role, joinedAt: DateTime(2025));

class _PendingPublishRelaySession extends RelaySessionNotifier {
  final Completer<NostrEvent> _result = Completer<NostrEvent>();
  final Completer<void> _published = Completer<void>();
  late NostrEvent event;

  Future<void> get published => _published.future;

  @override
  SessionState build() => const SessionState(status: SessionStatus.connected);

  @override
  Future<NostrEvent> publish(
    NostrEvent event, {
    Duration timeout = const Duration(seconds: 8),
  }) {
    this.event = event;
    _published.complete();
    return _result.future;
  }

  void accept() => _result.complete(event);

  void reject() => _result.completeError(Exception('relay rejected event'));
}
