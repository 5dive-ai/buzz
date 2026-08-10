part of 'thread_detail_page.dart';

int _threadTailIndex(int replyCount) => replyCount;

class _ThreadTailMetricsObserver with WidgetsBindingObserver {
  final VoidCallback onMetricsChanged;

  _ThreadTailMetricsObserver({required this.onMetricsChanged});

  @override
  void didChangeMetrics() => onMetricsChanged();
}

/// Serializes deferred tail work behind the latest user scroll intent.
class _ThreadTailIntent {
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
      WidgetsBinding.instance.scheduleFrame();
    });
  }
}

/// Thread-scoped typing status with optional size animation.
class _ThreadTypingIndicator extends StatelessWidget {
  final List<TypingEntry> entries;
  final bool animated;

  const _ThreadTypingIndicator({required this.entries, this.animated = true});

  @override
  Widget build(BuildContext context) {
    final child = entries.isEmpty
        ? const SizedBox.shrink()
        : ChannelTypingIndicator(entries: entries);
    if (!animated || MediaQuery.disableAnimationsOf(context)) return child;
    return AnimatedSize(
      duration: const Duration(milliseconds: 180),
      curve: Curves.easeOutCubic,
      alignment: Alignment.bottomCenter,
      child: child,
    );
  }
}
