import 'package:flutter/material.dart';

/// An [InkWell] whose long press is observed above interactive descendants.
class MessageLongPressInkWell extends StatelessWidget {
  final VoidCallback? onTap;
  final ValueChanged<Rect> onLongPress;
  final BorderRadius? borderRadius;
  final Color? highlightColor;
  final Widget child;

  const MessageLongPressInkWell({
    super.key,
    this.onTap,
    required this.onLongPress,
    this.borderRadius,
    this.highlightColor,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    return _MessageLongPressRegion(
      onLongPress: onLongPress,
      child: InkWell(
        onTap: onTap,
        borderRadius: borderRadius,
        highlightColor: highlightColor,
        child: child,
      ),
    );
  }
}

/// Detects a message long press through Flutter's gesture arena.
///
/// Links, media, reactions, and other nested controls keep their normal tap
/// gestures. A drag lets the surrounding scrollable win, while a completed
/// hold rejects descendant taps without manually cancelling the pointer.
class _MessageLongPressRegion extends StatelessWidget {
  final ValueChanged<Rect> onLongPress;
  final Widget child;

  const _MessageLongPressRegion({
    required this.onLongPress,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    void recognize() {
      final renderObject = context.findRenderObject();
      if (renderObject is! RenderBox || !renderObject.hasSize) return;
      onLongPress(renderObject.localToGlobal(Offset.zero) & renderObject.size);
    }

    return Semantics(
      onLongPress: recognize,
      child: GestureDetector(
        behavior: HitTestBehavior.translucent,
        onLongPressStart: (_) => recognize(),
        child: child,
      ),
    );
  }
}
