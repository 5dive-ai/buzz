import 'package:flutter/foundation.dart';

import '../../shared/relay/nostr_models.dart';

/// A user's NIP-38 status (kind:30315, d=general).
@immutable
class UserStatus {
  final String text;
  final String emoji;
  final int updatedAt;
  final int? expiresAt;

  const UserStatus({
    required this.text,
    required this.emoji,
    required this.updatedAt,
    this.expiresAt,
  });

  factory UserStatus.fromEvent(NostrEvent event) {
    final emojiTag = event.tags
        .where((t) => t.length >= 2 && t[0] == 'emoji')
        .firstOrNull;
    final expirationTag = event.tags
        .where((t) => t.length >= 2 && t[0] == 'expiration')
        .firstOrNull;
    return UserStatus(
      text: event.content,
      emoji: emojiTag?[1] ?? '',
      updatedAt: event.createdAt,
      expiresAt: int.tryParse(expirationTag?[1] ?? ''),
    );
  }

  bool get isEmpty => text.isEmpty && emoji.isEmpty;

  bool isExpiredAt(int unixSeconds) =>
      expiresAt != null && expiresAt! <= unixSeconds;
}
