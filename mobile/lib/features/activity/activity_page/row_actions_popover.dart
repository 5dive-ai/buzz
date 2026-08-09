part of '../activity_page.dart';

const _activityActionRowHeight = 50.0;
const _activityActionVerticalInset = Grid.half;
const _activityContextGap = Grid.twelve;
const _activityContextMenuMaxWidth = 288.0;
const _activityContextPreviewMaxWidth = 358.0;
const _activityContextPreviewInset = Grid.xxs;
const _activityContextTransitionDuration = Duration(milliseconds: 240);
const _activityActionSurfaceRadius = 26.0;
const _activityActionIconSize = 22.0;
const _activityActionIconSlotWidth = 32.0;
const _activityNativeActionSurfaceChannel = MethodChannel(
  'buzz/native_message_action_surface',
);

bool _activityRowActionsPresentationInFlight = false;
final _activityRowActionOverlayPresented = ValueNotifier(false);

enum _ActivityActionSurfaceKind { iosNative, androidFlutter }

class _ActivityRowAction {
  final String id;
  final String title;
  final String symbol;
  final IconData icon;
  final FutureOr<void> Function() onSelected;

  const _ActivityRowAction({
    required this.id,
    required this.title,
    required this.symbol,
    required this.icon,
    required this.onSelected,
  });

  Map<String, Object> toPlatformArguments() => {
    'id': id,
    'title': title,
    'symbol': symbol,
    'group': 'triage',
    'destructive': false,
  };
}

Future<bool> _showActivityRowActionsPopover({
  required BuildContext context,
  required Rect anchorRect,
  required Future<ui.Image> Function() captureAnchorSnapshot,
  required List<_ActivityRowAction> actions,
  required VoidCallback onPopoverPresented,
  required VoidCallback onPopoverDismissed,
}) async {
  if (_activityRowActionsPresentationInFlight) return true;
  _activityRowActionsPresentationInFlight = true;
  try {
    final surfaceKind = await _activityActionSurfaceKind();
    if (surfaceKind == null || !context.mounted) return false;

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
    _activityRowActionOverlayPresented.value = true;
    onPopoverPresented();
    String? selectedActionId;
    var overlayBuilt = false;
    var dismissalCompleted = false;

    void completeDismissal() {
      if (dismissalCompleted) return;
      dismissalCompleted = true;
      snapshot.dispose();
      _activityRowActionOverlayPresented.value = false;
      if (context.mounted) onPopoverDismissed();
    }

    try {
      selectedActionId = await showGeneralDialog<String>(
        context: context,
        barrierDismissible: true,
        barrierLabel: 'Dismiss activity actions',
        barrierColor: Colors.transparent,
        transitionDuration: reduceMotion
            ? Duration.zero
            : _activityContextTransitionDuration,
        transitionBuilder: (context, animation, secondaryAnimation, child) =>
            child,
        pageBuilder: (dialogContext, animation, secondaryAnimation) {
          overlayBuilt = true;
          return _ActivityRowActionsPopover(
            anchorRect: anchorRect,
            anchorSnapshot: snapshot,
            animation: animation,
            actions: actions,
            surfaceKind: surfaceKind,
            onTransitionDismissed: completeDismissal,
          );
        },
      );
    } finally {
      if (!overlayBuilt) completeDismissal();
    }

    final selectedAction = actions
        .where((action) => action.id == selectedActionId)
        .firstOrNull;
    if (selectedAction != null) await selectedAction.onSelected();
    return true;
  } finally {
    _activityRowActionsPresentationInFlight = false;
  }
}

Future<_ActivityActionSurfaceKind?> _activityActionSurfaceKind() async {
  if (defaultTargetPlatform != TargetPlatform.iOS) {
    return _ActivityActionSurfaceKind.androidFlutter;
  }
  try {
    final supported =
        await _activityNativeActionSurfaceChannel.invokeMethod<bool>(
          'isSupported',
        ) ??
        false;
    return supported ? _ActivityActionSurfaceKind.iosNative : null;
  } on MissingPluginException {
    return null;
  } on PlatformException {
    return null;
  }
}

class _ActivityRowActionsPopover extends HookWidget {
  final Rect anchorRect;
  final ui.Image anchorSnapshot;
  final Animation<double> animation;
  final List<_ActivityRowAction> actions;
  final _ActivityActionSurfaceKind surfaceKind;
  final VoidCallback onTransitionDismissed;

  const _ActivityRowActionsPopover({
    required this.anchorRect,
    required this.anchorSnapshot,
    required this.animation,
    required this.actions,
    required this.surfaceKind,
    required this.onTransitionDismissed,
  });

  @override
  Widget build(BuildContext context) {
    final transitionBegan = useRef(
      animation.status != AnimationStatus.dismissed,
    );
    useEffect(() {
      var completed = false;

      void finish() {
        if (completed) return;
        completed = true;
        onTransitionDismissed();
      }

      void handleStatus(AnimationStatus status) {
        if (status != AnimationStatus.dismissed) transitionBegan.value = true;
        if (transitionBegan.value && status == AnimationStatus.dismissed) {
          finish();
        }
      }

      animation.addStatusListener(handleStatus);
      handleStatus(animation.status);
      return () {
        animation.removeStatusListener(handleStatus);
        finish();
      };
    }, [animation, onTransitionDismissed]);

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
        final menuWidth = math.min(
          _activityContextMenuMaxWidth,
          availableWidth,
        );
        final preferredMenuHeight =
            (_activityActionVerticalInset * 2) +
            (actions.length * _activityActionRowHeight);
        final menuHeight = math.min(
          preferredMenuHeight,
          math.max(
            _activityActionRowHeight,
            availableHeight - _activityContextGap - 56,
          ),
        );
        final previewMaximumHeight = math.max(
          56,
          availableHeight - menuHeight - _activityContextGap,
        );
        final previewInsetExtent = _activityContextPreviewInset * 2;
        final previewScale = math.min(
          1,
          math.min(
            (math.min(_activityContextPreviewMaxWidth, availableWidth) -
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
        final previewLeft =
            safeLeft + ((availableWidth - previewSize.width) / 2);
        final totalHeight =
            previewSize.height + _activityContextGap + menuHeight;
        final contentTop = safeTop + ((availableHeight - totalHeight) / 2);
        final targetPreviewRect = Rect.fromLTWH(
          previewLeft,
          contentTop,
          previewSize.width,
          previewSize.height,
        );
        final menuRect = Rect.fromLTWH(
          safeLeft + ((availableWidth - menuWidth) / 2),
          targetPreviewRect.bottom + _activityContextGap,
          menuWidth,
          menuHeight,
        );

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
                  anchorRect.inflate(_activityContextPreviewInset),
                  targetPreviewRect,
                  movement,
                )!;
                return Positioned.fromRect(rect: displayRect, child: child!);
              },
              child: DecoratedBox(
                key: const ValueKey('activity-row-action-preview-container'),
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
                  padding: const EdgeInsets.all(_activityContextPreviewInset),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(Radii.xs),
                    child: RawImage(
                      key: const ValueKey('activity-row-action-preview'),
                      image: anchorSnapshot,
                      fit: BoxFit.fill,
                      filterQuality: FilterQuality.medium,
                    ),
                  ),
                ),
              ),
            ),
            Positioned.fromRect(
              rect: menuRect,
              child: AnimatedBuilder(
                animation: animation,
                child: surfaceKind == _ActivityActionSurfaceKind.iosNative
                    ? _IosNativeActivityActionSurface(actions: actions)
                    : _AndroidActivityActionSurface(actions: actions),
                builder: (context, child) {
                  final appearance = const Interval(
                    0.12,
                    0.72,
                    curve: Curves.easeOutCubic,
                  ).transform(animation.value);
                  return Opacity(
                    opacity: appearance,
                    child: Transform.scale(
                      alignment: Alignment.topCenter,
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

class _IosNativeActivityActionSurface extends HookWidget {
  final List<_ActivityRowAction> actions;

  const _IosNativeActivityActionSurface({required this.actions});

  @override
  Widget build(BuildContext context) {
    final viewId = useState<int?>(null);
    final navigator = Navigator.of(context);
    final navigatorRef = useRef(navigator)..value = navigator;

    useEffect(() {
      final id = viewId.value;
      if (id == null) return null;
      final channel = MethodChannel('buzz/native_message_action_surface/$id');
      channel.setMethodCallHandler((call) async {
        if (call.method != 'selected' || call.arguments is! Map) return;
        final actionId = (call.arguments as Map)['id'];
        if (actionId is String) navigatorRef.value.pop(actionId);
      });
      return () => channel.setMethodCallHandler(null);
    }, [viewId.value]);

    return ClipRRect(
      key: const ValueKey('activity-native-action-surface'),
      borderRadius: BorderRadius.circular(_activityActionSurfaceRadius),
      child: UiKitView(
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

class _AndroidActivityActionSurface extends StatelessWidget {
  final List<_ActivityRowAction> actions;

  const _AndroidActivityActionSurface({required this.actions});

  @override
  Widget build(BuildContext context) {
    return Material(
      key: const ValueKey('activity-android-action-surface'),
      color: context.colors.surfaceContainerHigh,
      surfaceTintColor: Colors.transparent,
      elevation: 10,
      shadowColor: Colors.black.withValues(alpha: 0.22),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(_activityActionSurfaceRadius),
        side: BorderSide(
          color: context.colors.outlineVariant.withValues(alpha: 0.55),
          width: 0.5,
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          vertical: _activityActionVerticalInset,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final action in actions)
              Semantics(
                button: true,
                label: action.title,
                excludeSemantics: true,
                child: InkWell(
                  key: ValueKey('activity-row-action-${action.id}'),
                  onTap: () => Navigator.of(context).pop(action.id),
                  child: SizedBox(
                    height: _activityActionRowHeight,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: Grid.xs),
                      child: Row(
                        children: [
                          SizedBox(
                            width: _activityActionIconSlotWidth,
                            child: Center(
                              child: Icon(
                                action.icon,
                                size: _activityActionIconSize,
                                color: context.colors.onSurface,
                              ),
                            ),
                          ),
                          const SizedBox(width: Grid.twelve),
                          Expanded(
                            child: Text(
                              action.title,
                              style: context.textTheme.bodyLarge?.copyWith(
                                color: context.colors.onSurface,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
