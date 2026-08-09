import 'channel.dart';

/// Semantic recipients for an outgoing mobile message.
///
/// Explicit mentions are always preserved. In a DM, participating agents are
/// also addressed with `p` tags without inserting visible `@mentions` into the
/// composer. Human DM participants and non-DM channels remain explicit-only.
List<String> messageMentionPubkeys({
  required Channel channel,
  required String? senderPubkey,
  required Iterable<String> explicitMentions,
  required Iterable<String> dmAgentPubkeys,
}) {
  final sender = senderPubkey?.toLowerCase();
  final candidates = <String>[
    ...explicitMentions,
    if (channel.isDm) ...dmAgentPubkeys,
  ];

  final seen = <String>{?sender};
  return [
    for (final candidate in candidates)
      if (candidate.trim().isNotEmpty && seen.add(candidate.toLowerCase()))
        candidate.toLowerCase(),
  ];
}
