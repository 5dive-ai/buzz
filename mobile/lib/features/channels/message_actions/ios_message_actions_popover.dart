part of '../message_actions.dart';

const _iosActionPromotedHeight = 72.0;
const _iosActionRowHeight = 50.0;
const _iosActionSeparatorHeight = 0.5;
const _iosActionVerticalInset = 4.0;
const _iosContextGap = Grid.twelve;
const _iosContextMenuMaxWidth = 288.0;
const _iosContextPreviewMaxWidth = 358.0;
const _iosContextPreviewInset = Grid.xxs;
const _iosContextTransitionDuration = Duration(milliseconds: 240);
bool _iosMessageActionsPresentationInFlight = false;

Future<bool> _showIosReactionOnlyPopover({
  required BuildContext context,
  required WidgetRef ref,
  required TimelineMessage message,
  required Rect anchorRect,
  required Future<ui.Image> Function() captureAnchorSnapshot,
  required EdgeInsets spotlightPadding,
  required VoidCallback? onPopoverPresented,
  required VoidCallback? onPopoverDismissed,
}) async {
  if (_iosMessageActionsPresentationInFlight) return true;
  _iosMessageActionsPresentationInFlight = true;
  try {
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
    try {
      await showGeneralDialog<void>(
        context: context,
        barrierDismissible: true,
        barrierLabel: 'Dismiss reaction picker',
        barrierColor: Colors.transparent,
        transitionDuration: reduceMotion
            ? Duration.zero
            : _iosContextTransitionDuration,
        transitionBuilder: (context, animation, secondaryAnimation, child) =>
            child,
        pageBuilder: (dialogContext, animation, secondaryAnimation) =>
            _IosMessageActionsPopover(
              anchorRect: anchorRect,
              anchorSnapshot: snapshot,
              spotlightPadding: spotlightPadding,
              animation: animation,
              message: message,
              pageContext: context,
              pageRef: ref,
              actions: const [],
            ),
      );
    } finally {
      snapshot.dispose();
      if (context.mounted) onPopoverDismissed?.call();
    }
    return true;
  } finally {
    _iosMessageActionsPresentationInFlight = false;
  }
}

Future<bool> _showIosMessageActionsPopover({
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
  if (_iosMessageActionsPresentationInFlight) return true;
  _iosMessageActionsPresentationInFlight = true;
  try {
    return await _presentIosMessageActionsPopover(
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
      spotlightPadding: spotlightPadding,
      onPopoverPresented: onPopoverPresented,
      onPopoverDismissed: onPopoverDismissed,
    );
  } finally {
    _iosMessageActionsPresentationInFlight = false;
  }
}

Future<bool> _presentIosMessageActionsPopover({
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
  if (!await _supportsIosNativeMessageActionSurface() || !context.mounted) {
    return false;
  }

  final actions = _buildIosNativeMessageActions(
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
          _IosMessageActionsPopover(
            anchorRect: anchorRect,
            anchorSnapshot: snapshot,
            spotlightPadding: spotlightPadding,
            animation: animation,
            message: message,
            pageContext: context,
            pageRef: ref,
            actions: actions,
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
}

class _IosMessageActionsPopover extends StatelessWidget {
  final Rect anchorRect;
  final ui.Image anchorSnapshot;
  final EdgeInsets spotlightPadding;
  final Animation<double> animation;
  final TimelineMessage message;
  final BuildContext pageContext;
  final WidgetRef pageRef;
  final List<_IosNativeMessageAction> actions;

  const _IosMessageActionsPopover({
    required this.anchorRect,
    required this.anchorSnapshot,
    required this.spotlightPadding,
    required this.animation,
    required this.message,
    required this.pageContext,
    required this.pageRef,
    required this.actions,
  });

  @override
  Widget build(BuildContext context) {
    final mediaQuery = MediaQuery.of(context);
    return LayoutBuilder(
      builder: (context, constraints) {
        final safeLeft = mediaQuery.padding.left + Grid.xxs;
        final safeRight =
            constraints.maxWidth - mediaQuery.padding.right - Grid.xxs;
        final safeTop = mediaQuery.padding.top + Grid.xxs;
        final safeBottom =
            constraints.maxHeight - mediaQuery.padding.bottom - Grid.xxs;
        final availableWidth = safeRight - safeLeft;
        final availableHeight = safeBottom - safeTop;
        final hasActionMenu = actions.isNotEmpty;
        final trayWidth = math.min(_reactionTrayMaxWidth, availableWidth);
        final menuWidth = hasActionMenu
            ? math.min(_iosContextMenuMaxWidth, availableWidth)
            : 0.0;
        final menuHeight = hasActionMenu
            ? math.min(
                _iosActionSurfacePreferredHeight(actions),
                math.max(
                  _iosActionRowHeight * 3,
                  availableHeight -
                      _reactionTrayMaxHeight -
                      (_iosContextGap * 2) -
                      56,
                ),
              )
            : 0.0;
        final contextGapCount = hasActionMenu ? 2 : 1;
        final previewMaximumHeight = math.max(
          56,
          availableHeight -
              _reactionTrayMaxHeight -
              menuHeight -
              (_iosContextGap * contextGapCount),
        );
        final previewInsetExtent = _iosContextPreviewInset * 2;
        final previewScale = math.min(
          1,
          math.min(
            (math.min(_iosContextPreviewMaxWidth, availableWidth) -
                    previewInsetExtent) /
                anchorRect.width,
            (previewMaximumHeight - previewInsetExtent) / anchorRect.height,
          ),
        );
        final previewContentSize = Size(
          anchorRect.width * previewScale,
          anchorRect.height * previewScale,
        );
        final previewSize = Size(
          previewContentSize.width + previewInsetExtent,
          previewContentSize.height + previewInsetExtent,
        );
        final trayLeft = safeLeft + ((availableWidth - trayWidth) / 2);
        final previewLeft =
            safeLeft + ((availableWidth - previewSize.width) / 2);
        final totalHeight =
            _reactionTrayMaxHeight +
            _iosContextGap +
            previewSize.height +
            (hasActionMenu ? _iosContextGap + menuHeight : 0);
        final contentTop = safeTop + ((availableHeight - totalHeight) / 2);
        final targetPreviewRect = Rect.fromLTWH(
          previewLeft,
          contentTop + _reactionTrayMaxHeight + _iosContextGap,
          previewSize.width,
          previewSize.height,
        );
        final menuRect = hasActionMenu
            ? Rect.fromLTWH(
                safeLeft + ((availableWidth - menuWidth) / 2),
                targetPreviewRect.bottom + _iosContextGap,
                menuWidth,
                menuHeight,
              )
            : null;

        return Stack(
          children: [
            Positioned.fill(
              child: AnimatedBuilder(
                animation: animation,
                builder: (context, child) {
                  final progress = Curves.easeOutCubic.transform(
                    animation.value,
                  );
                  return BackdropFilter(
                    filter: ui.ImageFilter.blur(
                      sigmaX: 14 * progress,
                      sigmaY: 14 * progress,
                    ),
                    child: ColoredBox(
                      color: context.colors.inverseSurface.withValues(
                        alpha: 0.12 * progress,
                      ),
                    ),
                  );
                },
              ),
            ),
            Positioned.fill(
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: () => Navigator.of(context).pop(),
              ),
            ),
            AnimatedBuilder(
              animation: animation,
              builder: (context, child) {
                final movement = Curves.easeInOutCubic.transform(
                  animation.value,
                );
                final displayRect = Rect.lerp(
                  anchorRect.inflate(_iosContextPreviewInset),
                  targetPreviewRect,
                  movement,
                )!;
                return Positioned.fromRect(rect: displayRect, child: child!);
              },
              child: DecoratedBox(
                key: const ValueKey('message-action-preview-container'),
                decoration: BoxDecoration(
                  color: context.colors.surfaceContainerHigh,
                  borderRadius: BorderRadius.circular(Radii.md),
                  border: Border.all(
                    color: context.colors.outlineVariant.withValues(alpha: 0.7),
                  ),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withValues(alpha: 0.18),
                      blurRadius: 18,
                      offset: const Offset(0, 8),
                    ),
                  ],
                ),
                child: Padding(
                  padding: const EdgeInsets.all(_iosContextPreviewInset),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(Radii.xs),
                    child: RawImage(
                      image: anchorSnapshot,
                      fit: BoxFit.fill,
                      filterQuality: FilterQuality.medium,
                    ),
                  ),
                ),
              ),
            ),
            Positioned(
              left: trayLeft,
              top: contentTop,
              width: trayWidth,
              height: _reactionTrayMaxHeight,
              child: _IosReactionTray(
                animation: animation,
                trayWidth: trayWidth,
                message: message,
                pageContext: pageContext,
                pageRef: pageRef,
              ),
            ),
            if (menuRect != null)
              Positioned.fromRect(
                rect: menuRect,
                child: AnimatedBuilder(
                  animation: animation,
                  child: _IosNativeMessageActionSurface(
                    actions: actions,
                    onSelected: (actionId) =>
                        Navigator.of(context).pop(actionId),
                  ),
                  builder: (context, child) {
                    final appearance = const Interval(
                      0.12,
                      0.72,
                      curve: Curves.easeOutCubic,
                    ).transform(animation.value);
                    return Opacity(
                      opacity: appearance,
                      child: Transform.scale(
                        alignment: Alignment.topLeft,
                        scale: ui.lerpDouble(0.96, 1, appearance)!,
                        child: child,
                      ),
                    );
                  },
                ),
              ),
          ],
        );
      },
    );
  }
}

class _IosReactionTray extends StatelessWidget {
  final Animation<double> animation;
  final double trayWidth;
  final TimelineMessage message;
  final BuildContext pageContext;
  final WidgetRef pageRef;

  const _IosReactionTray({
    required this.animation,
    required this.trayWidth,
    required this.message,
    required this.pageContext,
    required this.pageRef,
  });

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: animation,
      child: Padding(
        padding: const EdgeInsets.all(Grid.xxs),
        child: _QuickReactionRow(
          message: message,
          sheetContext: context,
          pageContext: pageContext,
          pageRef: pageRef,
          presentationAnimation: animation,
        ),
      ),
      builder: (context, child) {
        final appearance = const Interval(
          0.02,
          0.34,
          curve: Curves.easeOutCubic,
        ).transform(animation.value);
        final expansion = _reactionSpringCurve.transform(
          const Interval(0.08, 0.92).transform(animation.value),
        );
        return Opacity(
          opacity: appearance,
          child: Transform.scale(
            alignment: Alignment.centerLeft,
            scale: ui.lerpDouble(0.95, 1, appearance)!,
            child: Align(
              alignment: Alignment.centerLeft,
              child: SizedBox(
                key: const ValueKey('reaction-popover-tray'),
                width: ui.lerpDouble(
                  _reactionTrayMaxHeight,
                  trayWidth,
                  expansion,
                ),
                height: _reactionTrayMaxHeight,
                child: Material(
                  color: context.colors.surface,
                  surfaceTintColor: Colors.transparent,
                  elevation: 8,
                  shadowColor: Colors.black.withValues(alpha: 0.2),
                  shape: const StadiumBorder(),
                  clipBehavior: Clip.antiAlias,
                  child: OverflowBox(
                    alignment: Alignment.centerLeft,
                    minWidth: trayWidth,
                    maxWidth: trayWidth,
                    minHeight: _reactionTrayMaxHeight,
                    maxHeight: _reactionTrayMaxHeight,
                    child: child,
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

class _IosNativeMessageActionSurface extends HookWidget {
  final List<_IosNativeMessageAction> actions;
  final ValueChanged<String> onSelected;

  const _IosNativeMessageActionSurface({
    required this.actions,
    required this.onSelected,
  });

  @override
  Widget build(BuildContext context) {
    if (!Platform.isIOS) {
      return _TestIosNativeMessageActionSurface(
        actions: actions,
        onSelected: onSelected,
      );
    }

    final viewId = useState<int?>(null);
    useEffect(() {
      final id = viewId.value;
      if (id == null) return null;
      final channel = MethodChannel('buzz/native_message_action_surface/$id');
      channel.setMethodCallHandler((call) async {
        if (call.method != 'selected' || call.arguments is! Map) return;
        final actionId = (call.arguments as Map)['id'];
        if (actionId is String) onSelected(actionId);
      });
      return () => channel.setMethodCallHandler(null);
    }, [viewId.value, onSelected]);

    return ClipRRect(
      borderRadius: BorderRadius.circular(26),
      child: UiKitView(
        key: const ValueKey('ios-native-message-action-surface'),
        viewType: 'buzz/native_message_action_surface',
        creationParams: {
          'actions': [
            for (final action in actions) action.toPlatformArguments(),
          ],
        },
        creationParamsCodec: const StandardMessageCodec(),
        onPlatformViewCreated: (id) => viewId.value = id,
      ),
    );
  }
}

class _TestIosNativeMessageActionSurface extends StatelessWidget {
  final List<_IosNativeMessageAction> actions;
  final ValueChanged<String> onSelected;

  const _TestIosNativeMessageActionSurface({
    required this.actions,
    required this.onSelected,
  });

  @override
  Widget build(BuildContext context) {
    return Material(
      key: const ValueKey('ios-native-message-action-surface'),
      color: context.colors.surfaceContainerHigh,
      borderRadius: BorderRadius.circular(26),
      clipBehavior: Clip.antiAlias,
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final action in actions)
              SizedBox(
                height: action.group == _IosNativeMessageActionGroup.promoted
                    ? _iosActionPromotedHeight
                    : _iosActionRowHeight,
                child: ListTile(
                  key: ValueKey('ios-native-action-${action.id}'),
                  title: Text(action.title),
                  onTap: () => onSelected(action.id),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

double _iosActionSurfacePreferredHeight(List<_IosNativeMessageAction> actions) {
  final groups = {for (final action in actions) action.group};
  final promoted = groups.contains(_IosNativeMessageActionGroup.promoted);
  final rowCount = actions
      .where((action) => action.group != _IosNativeMessageActionGroup.promoted)
      .length;
  return (_iosActionVerticalInset * 2) +
      (promoted ? _iosActionPromotedHeight : 0) +
      (rowCount * _iosActionRowHeight) +
      (math.max(0, groups.length - 1) * _iosActionSeparatorHeight);
}
