import 'package:flutter/widgets.dart';

/// Serializes deferred tail work behind the latest user scroll intent.
class ThreadTailIntent {
  var _generation = 0;
  var isDragging = false;

  void detach() => _generation++;

  void beginDrag() {
    isDragging = true;
    detach();
  }

  void endDrag() => isDragging = false;

  void schedule({
    required bool allowed,
    required bool Function() revalidate,
    required VoidCallback action,
  }) {
    if (!allowed) return;
    final generation = ++_generation;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (generation == _generation && revalidate()) action();
      });
    });
  }
}
