part of '../message_actions.dart';

void showMessageActions({
  required BuildContext context,
  required WidgetRef ref,
  required TimelineMessage message,
  required String channelId,
  required bool canManageMessage,
  List<TimelineMessage>? allMessages,
  String? currentPubkey,
  bool isMember = false,
  bool isArchived = false,
  Rect? anchorRect,
  Future<ui.Image> Function()? captureAnchorSnapshot,
  EdgeInsets popoverSpotlightPadding = const EdgeInsets.all(Grid.xxs),
  VoidCallback? onPopoverPresented,
  VoidCallback? onPopoverDismissed,
}) {
  final hasReactionOnlyActions = message.isSystem && !canManageMessage;
  if (anchorRect != null && hasReactionOnlyActions) {
    if (Theme.of(context).platform == TargetPlatform.iOS &&
        captureAnchorSnapshot != null) {
      unawaited(
        _showIosReactionOnlyPopover(
          context: context,
          ref: ref,
          message: message,
          anchorRect: anchorRect,
          captureAnchorSnapshot: captureAnchorSnapshot,
          spotlightPadding: popoverSpotlightPadding,
          onPopoverPresented: onPopoverPresented,
          onPopoverDismissed: onPopoverDismissed,
        ).then((shown) {
          if (shown || !context.mounted) return;
          _showMessageReactionPopover(
            context: context,
            ref: ref,
            message: message,
            anchorRect: anchorRect,
            spotlightPadding: popoverSpotlightPadding,
          );
        }),
      );
      return;
    }
    _showMessageReactionPopover(
      context: context,
      ref: ref,
      message: message,
      anchorRect: anchorRect,
      spotlightPadding: popoverSpotlightPadding,
    );
    return;
  }

  if (anchorRect != null &&
      Theme.of(context).platform == TargetPlatform.iOS &&
      captureAnchorSnapshot != null) {
    unawaited(
      _showIosMessageActionsPopover(
        context: context,
        ref: ref,
        message: message,
        channelId: channelId,
        canManageMessage: canManageMessage,
        allMessages: allMessages,
        currentPubkey: currentPubkey,
        isMember: isMember,
        isArchived: isArchived,
        anchorRect: anchorRect,
        captureAnchorSnapshot: captureAnchorSnapshot,
        spotlightPadding: popoverSpotlightPadding,
        onPopoverPresented: onPopoverPresented,
        onPopoverDismissed: onPopoverDismissed,
      ).then((shown) {
        if (shown || !context.mounted) return;
        _showMessageActionsSheet(
          context: context,
          ref: ref,
          message: message,
          channelId: channelId,
          canManageMessage: canManageMessage,
          allMessages: allMessages,
          currentPubkey: currentPubkey,
          isMember: isMember,
          isArchived: isArchived,
        );
      }),
    );
    return;
  }

  if (anchorRect != null &&
      Theme.of(context).platform == TargetPlatform.android &&
      captureAnchorSnapshot != null) {
    unawaited(
      _showAndroidMessageActionsPopover(
        context: context,
        ref: ref,
        message: message,
        channelId: channelId,
        canManageMessage: canManageMessage,
        allMessages: allMessages,
        currentPubkey: currentPubkey,
        isMember: isMember,
        isArchived: isArchived,
        anchorRect: anchorRect,
        captureAnchorSnapshot: captureAnchorSnapshot,
        spotlightPadding: popoverSpotlightPadding,
        onPopoverPresented: onPopoverPresented,
        onPopoverDismissed: onPopoverDismissed,
      ).then((shown) {
        if (shown || !context.mounted) return;
        _showMessageActionsSheet(
          context: context,
          ref: ref,
          message: message,
          channelId: channelId,
          canManageMessage: canManageMessage,
          allMessages: allMessages,
          currentPubkey: currentPubkey,
          isMember: isMember,
          isArchived: isArchived,
        );
      }),
    );
    return;
  }

  _showMessageActionsSheet(
    context: context,
    ref: ref,
    message: message,
    channelId: channelId,
    canManageMessage: canManageMessage,
    allMessages: allMessages,
    currentPubkey: currentPubkey,
    isMember: isMember,
    isArchived: isArchived,
  );
}
