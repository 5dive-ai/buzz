part of '../message_actions.dart';

const _nativeMessageActionSurfaceChannel = MethodChannel(
  'buzz/native_message_action_surface',
);

List<_MessageAction> _buildMessageActions({
  required BuildContext context,
  required WidgetRef ref,
  required TimelineMessage message,
  required String channelId,
  required bool canManageMessage,
  required List<TimelineMessage>? allMessages,
  required String? currentPubkey,
  required bool isMember,
  required bool isArchived,
}) {
  final actions = <_MessageAction>[];
  final messages = allMessages;
  final canRemind = ref.read(reminderServiceProvider) != null;

  if (!message.isSystem) {
    if (messages != null) {
      actions.add(
        _MessageAction(
          id: 'reply',
          title: 'Reply',
          symbol: 'arrowshape.turn.up.left',
          group: _MessageActionGroup.promoted,
          onSelected: () {
            if (!context.mounted) return;
            Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => ThreadDetailPage(
                  threadHead: message,
                  allMessages: messages,
                  channelId: channelId,
                  currentPubkey: currentPubkey,
                  isMember: isMember,
                  isArchived: isArchived,
                ),
              ),
            );
          },
        ),
      );
    }
    actions.add(
      _MessageAction(
        id: 'copyLink',
        title: 'Copy link',
        symbol: 'link',
        group: _MessageActionGroup.promoted,
        onSelected: () {
          if (!context.mounted) return;
          copyToClipboard(
            context,
            messageLinkFor(message: message, channelId: channelId),
            message: 'Message link copied',
          );
        },
      ),
    );
    if (canRemind) {
      actions.add(
        _MessageAction(
          id: 'remind',
          title: 'Remind me',
          symbol: 'clock',
          group: _MessageActionGroup.promoted,
          onSelected: () {
            if (!context.mounted) return;
            showRemindMeLaterSheet(
              context: Navigator.of(context, rootNavigator: true).context,
              ref: ref,
              target: ReminderTarget(
                eventId: message.id,
                channelId: channelId,
                preview: message.content.characters
                    .take(_reminderPreviewLength)
                    .toString(),
                authorPubkey: message.pubkey,
              ),
            );
          },
        ),
      );
    }

    final readState = ref.read(readStateProvider);
    if (readState.isReady) {
      final unread = isMessageUnread(
        readState,
        channelId: channelId,
        messageId: message.id,
        createdAt: message.createdAt,
        threadRootId: message.rootId,
      );
      actions.add(
        _MessageAction(
          id: unread ? 'markRead' : 'markUnread',
          title: unread ? 'Mark read' : 'Mark unread',
          symbol: unread ? 'envelope.open' : 'envelope.badge',
          group: _MessageActionGroup.triage,
          onSelected: () {
            final notifier = ref.read(readStateProvider.notifier);
            if (unread) {
              notifier.markContextRead(
                msgContextKey(message.id),
                message.createdAt,
              );
            } else {
              notifier.markContextUnread(
                msgContextKey(message.id),
                channelId: channelId,
              );
            }
          },
        ),
      );
    }

    final rootId = message.rootId ?? message.id;
    final following = ref.read(threadFollowsProvider).isFollowing(rootId);
    actions.add(
      _MessageAction(
        id: following ? 'unfollowThread' : 'followThread',
        title: following ? 'Unfollow thread' : 'Follow thread',
        symbol: following ? 'bell.slash' : 'bell',
        group: _MessageActionGroup.triage,
        onSelected: () {
          final notifier = ref.read(threadFollowsProvider.notifier);
          if (following) {
            notifier.unfollowThread(rootId);
          } else {
            notifier.followThread(rootId);
          }
        },
      ),
    );
    actions.add(
      _MessageAction(
        id: 'copyText',
        title: 'Copy text',
        symbol: 'doc.on.doc',
        group: _MessageActionGroup.export,
        onSelected: () =>
            Clipboard.setData(ClipboardData(text: message.content)),
      ),
    );
  }

  if (canManageMessage) {
    actions.add(
      _MessageAction(
        id: 'edit',
        title: 'Edit message',
        symbol: 'pencil',
        group: _MessageActionGroup.manage,
        onSelected: () {
          if (!context.mounted) return;
          _showEditSheet(
            context: context,
            ref: ref,
            message: message,
            channelId: channelId,
          );
        },
      ),
    );
    actions.add(
      _MessageAction(
        id: 'delete',
        title: 'Delete message',
        symbol: 'trash',
        group: _MessageActionGroup.manage,
        destructive: true,
        onSelected: () {
          if (!context.mounted) return;
          _confirmDelete(
            context: context,
            ref: ref,
            channelId: channelId,
            messageId: message.id,
          );
        },
      ),
    );
  }

  return actions;
}

enum _MessageActionGroup { promoted, triage, export, manage }

class _MessageAction {
  final String id;
  final String title;
  final String symbol;
  final _MessageActionGroup group;
  final bool destructive;
  final FutureOr<void> Function() onSelected;

  const _MessageAction({
    required this.id,
    required this.title,
    required this.symbol,
    required this.group,
    required this.onSelected,
    this.destructive = false,
  });

  IconData get flutterIcon => switch (id) {
    'reply' => LucideIcons.messageSquareReply,
    'copyLink' => LucideIcons.link2,
    'remind' => LucideIcons.clock,
    'markRead' => LucideIcons.mailCheck,
    'markUnread' => LucideIcons.mailOpen,
    'followThread' => LucideIcons.bellRing,
    'unfollowThread' => LucideIcons.bellOff,
    'copyText' => LucideIcons.copy,
    'edit' => LucideIcons.pencil,
    'delete' => LucideIcons.trash2,
    _ => LucideIcons.ellipsis,
  };

  Map<String, Object> toPlatformArguments() => {
    'id': id,
    'title': title,
    'symbol': symbol,
    'group': group.name,
    'destructive': destructive,
  };
}

Future<bool> _supportsIosNativeMessageActionSurface() async {
  try {
    return await _nativeMessageActionSurfaceChannel.invokeMethod<bool>(
          'isSupported',
        ) ??
        false;
  } on MissingPluginException {
    return false;
  } on PlatformException {
    return false;
  }
}
