part of '../message_actions.dart';

const _androidActionRowMinHeight = 52.0;
const _androidActionSeparatorHeight = 0.5;
const _androidActionVerticalInset = Grid.half;
const _androidContextMenuMaxWidth = 288.0;
const _androidContextMenuRadius = 26.0;
const _androidActionIconSize = 22.0;
const _androidActionIconSlotWidth = 32.0;
bool _androidMessageActionsPresentationInFlight = false;

Future<bool> _showAndroidMessageActionsPopover({
  required BuildContext context,
  required WidgetRef ref,
  required TimelineMessage message,
  required String channelId,
  required bool canManageMessage,
  required List<TimelineMessage>? allMessages,
  required String? currentPubkey,
  required bool isMember,
  required bool isArchived,
  required Rect anchorRect,
  required Future<ui.Image> Function() captureAnchorSnapshot,
  required EdgeInsets spotlightPadding,
  required VoidCallback? onPopoverPresented,
  required VoidCallback? onPopoverDismissed,
}) async {
  if (_androidMessageActionsPresentationInFlight) return true;
  _androidMessageActionsPresentationInFlight = true;
  try {
    final actions = _buildMessageActions(
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
    if (actions.isEmpty) return false;

    final ui.Image snapshot;
    try {
      snapshot = await captureAnchorSnapshot();
    } catch (_) {
      return false;
    }
    if (!context.mounted) {
      snapshot.dispose();
      return false;
    }

    unawaited(HapticFeedback.mediumImpact());
    final reduceMotion = MediaQuery.disableAnimationsOf(context);
    onPopoverPresented?.call();
    String? selectedActionId;
    try {
      selectedActionId = await showGeneralDialog<String>(
        context: context,
        barrierDismissible: true,
        barrierLabel: 'Dismiss message actions',
        barrierColor: Colors.transparent,
        transitionDuration: reduceMotion
            ? Duration.zero
            : _iosContextTransitionDuration,
        transitionBuilder: (context, animation, secondaryAnimation, child) =>
            child,
        pageBuilder: (dialogContext, animation, secondaryAnimation) =>
            _MessageActionsPopover(
              anchorRect: anchorRect,
              anchorSnapshot: snapshot,
              spotlightPadding: spotlightPadding,
              animation: animation,
              message: message,
              pageContext: context,
              pageRef: ref,
              actions: actions,
              actionSurfaceKind: _MessageActionSurfaceKind.androidFlutter,
            ),
      );
    } finally {
      snapshot.dispose();
      if (context.mounted) onPopoverDismissed?.call();
    }

    final selectedAction = actions
        .where((action) => action.id == selectedActionId)
        .firstOrNull;
    if (selectedAction != null) await selectedAction.onSelected();
    return true;
  } finally {
    _androidMessageActionsPresentationInFlight = false;
  }
}

class _AndroidMessageActionSurface extends StatelessWidget {
  final List<_MessageAction> actions;
  final ValueChanged<String> onSelected;

  const _AndroidMessageActionSurface({
    required this.actions,
    required this.onSelected,
  });

  @override
  Widget build(BuildContext context) {
    return Material(
      key: const ValueKey('android-message-action-surface'),
      color: context.colors.surfaceContainerHigh,
      surfaceTintColor: Colors.transparent,
      elevation: 10,
      shadowColor: Colors.black.withValues(alpha: 0.22),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(_androidContextMenuRadius),
        side: BorderSide(
          color: context.colors.outlineVariant.withValues(alpha: 0.55),
          width: 0.5,
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: SingleChildScrollView(
        child: Padding(
          padding: const EdgeInsets.symmetric(
            vertical: _androidActionVerticalInset,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (var index = 0; index < actions.length; index++) ...[
                if (index > 0 &&
                    actions[index - 1].group != actions[index].group)
                  Container(
                    key: ValueKey(
                      'android-message-action-divider-${actions[index].group.name}',
                    ),
                    height: _androidActionSeparatorHeight,
                    margin: const EdgeInsets.symmetric(horizontal: Grid.xs),
                    color: context.colors.outlineVariant.withValues(alpha: 0.7),
                  ),
                _AndroidMessageActionRow(
                  action: actions[index],
                  onSelected: onSelected,
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _AndroidMessageActionRow extends StatelessWidget {
  final _MessageAction action;
  final ValueChanged<String> onSelected;

  const _AndroidMessageActionRow({
    required this.action,
    required this.onSelected,
  });

  @override
  Widget build(BuildContext context) {
    final foreground = action.destructive
        ? context.colors.error
        : context.colors.onSurface;
    return Semantics(
      button: true,
      label: action.title,
      excludeSemantics: true,
      child: InkWell(
        key: ValueKey('android-message-action-${action.id}'),
        onTap: () => onSelected(action.id),
        child: ConstrainedBox(
          constraints: const BoxConstraints(
            minHeight: _androidActionRowMinHeight,
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: Grid.xs,
              vertical: Grid.xxs,
            ),
            child: Row(
              children: [
                SizedBox(
                  width: _androidActionIconSlotWidth,
                  child: Center(
                    child: Icon(
                      action.flutterIcon,
                      key: ValueKey('android-message-action-icon-${action.id}'),
                      size: _androidActionIconSize,
                      color: foreground,
                    ),
                  ),
                ),
                const SizedBox(width: Grid.twelve),
                Expanded(
                  child: Text(
                    action.title,
                    key: ValueKey('android-message-action-label-${action.id}'),
                    style: context.textTheme.bodyLarge?.copyWith(
                      color: foreground,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

double _androidActionSurfacePreferredHeight(List<_MessageAction> actions) {
  var separatorCount = 0;
  for (var index = 1; index < actions.length; index++) {
    if (actions[index - 1].group != actions[index].group) separatorCount += 1;
  }
  return (_androidActionVerticalInset * 2) +
      (actions.length * _androidActionRowMinHeight) +
      (separatorCount * _androidActionSeparatorHeight);
}
