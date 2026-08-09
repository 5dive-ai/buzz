import 'package:buzz/features/channels/channel.dart';
import 'package:buzz/features/channels/message_mention_pubkeys.dart';
import 'package:flutter_test/flutter_test.dart';

const _self = 'self';
const _agent = 'agent';
const _human = 'human';

void main() {
  test('implicitly addresses a participating DM agent', () {
    expect(
      messageMentionPubkeys(
        channel: _channel(
          type: 'dm',
          participantPubkeys: const [_self, _agent],
        ),
        senderPubkey: _self,
        explicitMentions: const [],
        dmAgentPubkeys: const [_agent],
      ),
      [_agent],
    );
  });

  test('preserves explicit mentions alongside the implicit DM agent', () {
    expect(
      messageMentionPubkeys(
        channel: _channel(
          type: 'dm',
          participantPubkeys: const [_self, _agent, _human],
        ),
        senderPubkey: _self,
        explicitMentions: const [_human, _agent],
        dmAgentPubkeys: const [_agent],
      ),
      [_human, _agent],
    );
  });

  test('does not implicitly address human DMs or channel agents', () {
    expect(
      messageMentionPubkeys(
        channel: _channel(
          type: 'dm',
          participantPubkeys: const [_self, _human],
        ),
        senderPubkey: _self,
        explicitMentions: const [],
        dmAgentPubkeys: const [],
      ),
      isEmpty,
    );
    expect(
      messageMentionPubkeys(
        channel: _channel(
          type: 'stream',
          participantPubkeys: const [_self, _agent],
        ),
        senderPubkey: _self,
        explicitMentions: const [],
        dmAgentPubkeys: const [_agent],
      ),
      isEmpty,
    );
  });
}

Channel _channel({
  required String type,
  required List<String> participantPubkeys,
}) => Channel(
  id: 'channel',
  name: 'Conversation',
  channelType: type,
  visibility: 'private',
  description: '',
  createdBy: _self,
  createdAt: DateTime(2025),
  memberCount: participantPubkeys.length,
  participantPubkeys: participantPubkeys,
  isMember: true,
);
