import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';

class LaidOutViewport {
  final key = GlobalKey();
  final height = ValueNotifier(0.0);

  void reportAfterLayout() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final renderObject = key.currentContext?.findRenderObject();
      if (renderObject is! RenderBox || !renderObject.hasSize) return;
      final nextHeight = renderObject.size.height;
      if ((height.value - nextHeight).abs() < 0.5) return;
      height.value = nextHeight;
    });
  }

  void dispose() => height.dispose();
}

class LaidOutViewportReporter extends HookWidget {
  final LaidOutViewport viewport;
  final Widget child;

  const LaidOutViewportReporter({
    super.key,
    required this.viewport,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    useEffect(() {
      viewport.reportAfterLayout();
      return null;
    }, [viewport]);

    return NotificationListener<SizeChangedLayoutNotification>(
      onNotification: (_) {
        viewport.reportAfterLayout();
        return true;
      },
      child: SizeChangedLayoutNotifier(
        child: KeyedSubtree(key: viewport.key, child: child),
      ),
    );
  }
}
