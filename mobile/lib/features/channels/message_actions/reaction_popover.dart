part of '../message_actions.dart';

const _reactionTrayMaxWidth =
    (_quickReactionDesiredTargetSize * (_quickReactionEmojiLimit + 1)) +
    (Grid.xxs * 2);
const _reactionTrayMaxHeight = 52.0 + (Grid.xxs * 2);
const _reactionTraySpringAllowance = 16.0;
const _reactionTrayMessageGap = Grid.twelve;
const _reactionPopoverDuration = Duration(milliseconds: 320);
final _reactionSpringCurve = _SpringEaseOutCurve(
  duration: const Duration(milliseconds: 260),
  bounce: 0.22,
);

/// Presents the frequently-used reaction tray over a long-pressed message.
///
/// The conversation is frosted around [anchorRect] so the selected message
/// remains visually connected to the tray.
_MessageReactionPopoverHandle _showMessageReactionPopover({
  required BuildContext context,
  required WidgetRef ref,
  required TimelineMessage message,
  required Rect anchorRect,
  Rect? originalAnchorRect,
  ui.Image? anchorSnapshot,
  required EdgeInsets spotlightPadding,
  bool alignTrayToAnchorStart = false,
  bool triggerHaptic = true,
}) {
  if (triggerHaptic) unawaited(HapticFeedback.mediumImpact());
  final reduceMotion = MediaQuery.disableAnimationsOf(context);
  final contextReady = Completer<BuildContext>();
  final closed = showGeneralDialog<void>(
    context: context,
    barrierDismissible: true,
    barrierLabel: 'Dismiss reaction picker',
    barrierColor: Colors.transparent,
    transitionDuration: reduceMotion ? Duration.zero : _reactionPopoverDuration,
    transitionBuilder: (context, animation, secondaryAnimation, child) => child,
    pageBuilder: (dialogContext, animation, secondaryAnimation) {
      if (!contextReady.isCompleted) contextReady.complete(dialogContext);
      return _MessageReactionPopover(
        anchorRect: anchorRect,
        originalAnchorRect: originalAnchorRect ?? anchorRect,
        anchorSnapshot: anchorSnapshot,
        spotlightPadding: spotlightPadding,
        alignTrayToAnchorStart: alignTrayToAnchorStart,
        animation: animation,
        message: message,
        pageContext: context,
        pageRef: ref,
      );
    },
  );
  return _MessageReactionPopoverHandle(
    contextReady: contextReady.future,
    closed: closed,
  );
}

class _MessageReactionPopoverHandle {
  final Future<BuildContext> contextReady;
  final Future<void> closed;
  bool _isOpen = true;

  _MessageReactionPopoverHandle({
    required this.contextReady,
    required this.closed,
  }) {
    unawaited(closed.whenComplete(() => _isOpen = false));
  }

  Future<void> close() async {
    if (!_isOpen) return;
    _isOpen = false;
    final context = await contextReady;
    if (context.mounted) Navigator.of(context).pop();
    await closed;
  }
}

class _MessageReactionPopover extends HookWidget {
  final Rect anchorRect;
  final Rect originalAnchorRect;
  final ui.Image? anchorSnapshot;
  final EdgeInsets spotlightPadding;
  final bool alignTrayToAnchorStart;
  final Animation<double> animation;
  final TimelineMessage message;
  final BuildContext pageContext;
  final WidgetRef pageRef;

  const _MessageReactionPopover({
    required this.anchorRect,
    required this.originalAnchorRect,
    required this.anchorSnapshot,
    required this.spotlightPadding,
    required this.alignTrayToAnchorStart,
    required this.animation,
    required this.message,
    required this.pageContext,
    required this.pageRef,
  });

  @override
  Widget build(BuildContext context) {
    useEffect(() {
      // The popover owns the transient snapshot. Releasing it when this widget
      // unmounts keeps the image alive through the complete dismissal paint.
      return () => anchorSnapshot?.dispose();
    }, [anchorSnapshot]);
    final mediaQuery = MediaQuery.of(context);

    return LayoutBuilder(
      builder: (context, constraints) {
        final safeTop = mediaQuery.padding.top + mediaQuery.viewInsets.top;
        final safeBottom =
            constraints.maxHeight -
            mediaQuery.padding.bottom -
            mediaQuery.viewInsets.bottom;
        final availableAbove =
            anchorRect.top - _reactionTrayMessageGap - safeTop;
        final availableBelow =
            safeBottom - anchorRect.bottom - _reactionTrayMessageGap;
        final showAbove =
            availableAbove >= _reactionTrayMaxHeight ||
            (availableBelow < _reactionTrayMaxHeight &&
                availableAbove >= availableBelow);
        final proposedTop = showAbove
            ? anchorRect.top - _reactionTrayMaxHeight - _reactionTrayMessageGap
            : anchorRect.bottom + _reactionTrayMessageGap;
        final maxTop = math.max(safeTop, safeBottom - _reactionTrayMaxHeight);
        final top = proposedTop.clamp(safeTop, maxTop).toDouble();
        final trayScaleAlignment = showAbove
            ? Alignment.bottomLeft
            : Alignment.topLeft;
        final trayWidth = math.min(
          _reactionTrayMaxWidth,
          constraints.maxWidth - (Grid.xxs * 2),
        );
        final maxLeft = constraints.maxWidth - trayWidth - Grid.xxs;
        final preferredLeft = alignTrayToAnchorStart
            ? anchorRect.left
            : anchorRect.center.dx - (trayWidth / 2);
        final left = preferredLeft.clamp(Grid.xxs, maxLeft).toDouble();

        return Stack(
          children: [
            Positioned.fill(
              child: AnimatedBuilder(
                animation: animation,
                builder: (context, child) {
                  final blurProgress = const Interval(
                    0,
                    0.30,
                    curve: Curves.easeOutCubic,
                  ).transform(animation.value);
                  final sigma = 20 * blurProgress;
                  final background = BackdropFilter(
                    filter: ui.ImageFilter.blur(sigmaX: sigma, sigmaY: sigma),
                    child: ColoredBox(
                      color: context.colors.inverseSurface.withValues(
                        alpha: 0.10 * blurProgress,
                      ),
                    ),
                  );
                  if (anchorSnapshot != null) return background;
                  return ClipPath(
                    key: const ValueKey('reaction-popover-background'),
                    clipper: _OutsideAnchorClipper(
                      anchorRect,
                      spotlightPadding,
                    ),
                    child: background,
                  );
                },
              ),
            ),
            if (anchorSnapshot != null)
              Positioned.fill(
                child: IgnorePointer(
                  child: AnimatedBuilder(
                    animation: animation,
                    builder: (context, child) {
                      final movement = const Interval(
                        0,
                        0.56,
                        curve: Curves.easeInOutCubic,
                      ).transform(animation.value);
                      final displayRect = Rect.lerp(
                        originalAnchorRect,
                        anchorRect,
                        movement,
                      )!;
                      return Stack(
                        children: [
                          Positioned.fromRect(
                            rect: displayRect,
                            child: DecoratedBox(
                              key: const ValueKey(
                                'message-action-preview-container',
                              ),
                              decoration: BoxDecoration(
                                color: context.colors.surfaceContainerHigh,
                                borderRadius: BorderRadius.circular(Radii.md),
                                border: Border.all(
                                  color: context.colors.outlineVariant
                                      .withValues(alpha: 0.65),
                                ),
                                boxShadow: [
                                  BoxShadow(
                                    color: Colors.black.withValues(alpha: 0.12),
                                    blurRadius: 16,
                                    offset: const Offset(0, 6),
                                  ),
                                ],
                              ),
                              child: ClipRRect(
                                borderRadius: BorderRadius.circular(Radii.md),
                                child: RawImage(
                                  image: anchorSnapshot,
                                  fit: BoxFit.fill,
                                  filterQuality: FilterQuality.medium,
                                ),
                              ),
                            ),
                          ),
                        ],
                      );
                    },
                  ),
                ),
              ),
            Positioned.fill(
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: () => Navigator.of(context).pop(),
              ),
            ),
            Positioned(
              top: top,
              left: left,
              width: trayWidth + _reactionTraySpringAllowance,
              height: _reactionTrayMaxHeight,
              child: AnimatedBuilder(
                animation: animation,
                child: SizedBox(
                  width: trayWidth,
                  height: _reactionTrayMaxHeight,
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
                ),
                builder: (context, child) {
                  final appearance = const Interval(
                    0.04,
                    0.23,
                    curve: Curves.easeOutCubic,
                  ).transform(animation.value);
                  final expansion = const Interval(
                    0.16,
                    0.92,
                  ).transform(animation.value);
                  final springExpansion = _reactionSpringCurve.transform(
                    expansion,
                  );
                  final width = ui.lerpDouble(
                    _reactionTrayMaxHeight,
                    trayWidth,
                    springExpansion,
                  )!;

                  return Opacity(
                    opacity: appearance,
                    child: Transform.scale(
                      alignment: trayScaleAlignment,
                      scale: ui.lerpDouble(0.95, 1, appearance)!,
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: SizedBox(
                          key: const ValueKey('reaction-popover-tray'),
                          width: width,
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
              ),
            ),
          ],
        );
      },
    );
  }
}

class _OutsideAnchorClipper extends CustomClipper<Path> {
  final Rect anchorRect;
  final EdgeInsets spotlightPadding;

  const _OutsideAnchorClipper(this.anchorRect, this.spotlightPadding);

  @override
  Path getClip(Size size) {
    final spotlightRect = Rect.fromLTRB(
      anchorRect.left - spotlightPadding.left,
      anchorRect.top - spotlightPadding.top,
      anchorRect.right + spotlightPadding.right,
      anchorRect.bottom + spotlightPadding.bottom,
    );
    return Path()
      ..fillType = PathFillType.evenOdd
      ..addRect(Offset.zero & size)
      ..addRRect(
        RRect.fromRectAndRadius(spotlightRect, const Radius.circular(Radii.lg)),
      );
  }

  @override
  bool shouldReclip(_OutsideAnchorClipper oldClipper) =>
      oldClipper.anchorRect != anchorRect ||
      oldClipper.spotlightPadding != spotlightPadding;
}

class _SpringEaseOutCurve extends Curve {
  final double _durationSeconds;
  final SpringSimulation _simulation;

  _SpringEaseOutCurve({required Duration duration, required double bounce})
    : _durationSeconds =
          duration.inMicroseconds / Duration.microsecondsPerSecond,
      _simulation = SpringSimulation(
        SpringDescription.withDurationAndBounce(
          duration: duration,
          bounce: bounce,
        ),
        0,
        1,
        0,
        snapToEnd: true,
      );

  @override
  double transformInternal(double t) => _simulation.x(t * _durationSeconds);
}
