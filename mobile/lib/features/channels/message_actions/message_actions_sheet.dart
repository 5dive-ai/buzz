part of '../message_actions.dart';

void _showMessageActionsSheet({
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
  showBuzzModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    showCloseButton: false,
    builder: (sheetContext) => SafeArea(
      child: IconTheme.merge(
        data: const IconThemeData(size: 22),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.sizeOf(sheetContext).height * 0.7,
          ),
          child: SingleChildScrollView(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(
                Grid.gutter,
                0,
                Grid.gutter,
                Grid.xs,
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  _QuickReactionRow(
                    message: message,
                    sheetContext: sheetContext,
                    pageContext: context,
                    pageRef: ref,
                  ),
                  const SizedBox(height: Grid.xs),
                  if (!message.isSystem) ...[
                    // Fast actions: respond now, hand off context, defer.
                    _FastActionsRow(
                      message: message,
                      channelId: channelId,
                      allMessages: allMessages,
                      currentPubkey: currentPubkey,
                      isMember: isMember,
                      isArchived: isArchived,
                      pageContext: context,
                    ),
                    const SizedBox(height: Grid.xs),
                    // Triage: come back to this message later.
                    _MarkReadUnreadTile(message: message, channelId: channelId),
                    _FollowThreadTile(message: message),
                    const SheetDivider(),
                    // Export: take the content out of the conversation.
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: const Icon(LucideIcons.copy),
                      title: const Text('Copy text'),
                      onTap: () {
                        Navigator.of(sheetContext).pop();
                        final data = ClipboardData(text: message.content);
                        Clipboard.setData(data);
                      },
                    ),
                  ],
                  if (canManageMessage) ...[
                    if (!message.isSystem) const SheetDivider(),
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: const Icon(LucideIcons.pencil),
                      title: const Text('Edit message'),
                      onTap: () {
                        Navigator.of(sheetContext).pop();
                        _showEditSheet(
                          context: context,
                          ref: ref,
                          message: message,
                          channelId: channelId,
                        );
                      },
                    ),
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: Icon(
                        LucideIcons.trash2,
                        color: sheetContext.colors.error,
                      ),
                      title: Text(
                        'Delete message',
                        style: TextStyle(color: sheetContext.colors.error),
                      ),
                      onTap: () {
                        Navigator.of(sheetContext).pop();
                        _confirmDelete(
                          context: context,
                          ref: ref,
                          channelId: channelId,
                          messageId: message.id,
                        );
                      },
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    ),
  );
}
