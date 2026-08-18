import 'dart:async';

import 'package:buzz/shared/widgets/brand_refresh_indicator.dart';
import 'package:buzz/shared/widgets/fivedive_mark.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../helpers/widget_helpers.dart';

void main() {
  testWidgets('shows the 5dive mark while pulling to refresh', (tester) async {
    const contentKey = ValueKey('loading-content');
    var refreshes = 0;
    final refreshCompleter = Completer<void>();

    await tester.pumpWidget(
      WidgetHelpers.testable(
        child: BrandRefreshIndicator(
          onRefresh: () {
            refreshes++;
            return refreshCompleter.future;
          },
          child: ListView(
            children: const [SizedBox(key: contentKey, height: 800)],
          ),
        ),
      ),
    );

    final listFinder = find.byType(ListView);
    final restingTop = tester.getTopLeft(listFinder).dy;
    final restingContentTop = tester.getTopLeft(find.byKey(contentKey)).dy;
    await tester.timedDrag(
      listFinder,
      const Offset(0, 320),
      const Duration(milliseconds: 500),
    );
    await tester.pump(const Duration(milliseconds: 16));
    await tester.pump(const Duration(milliseconds: 300));

    final markFinder = find.byType(FiveDiveMark);
    final loadingTop = tester.getTopLeft(listFinder).dy;
    final loadingContentTop = tester.getTopLeft(find.byKey(contentKey)).dy;
    final gapTransform = tester.widget<Transform>(
      find.byKey(const ValueKey('brand-refresh-retained-gap')),
    );
    expect(markFinder, findsOneWidget);
    expect(refreshes, 1);
    expect(gapTransform.transform.getTranslation().y, closeTo(72, 1));
    expect(loadingTop - restingTop, closeTo(72, 1));
    final loadingMarkRect = tester.getRect(markFinder);
    final loadingGap = loadingContentTop - restingContentTop;
    expect(
      loadingMarkRect.center.dy,
      closeTo(
        restingContentTop +
            (loadingGap - loadingMarkRect.height) * 0.75 +
            loadingMarkRect.height / 2,
        1,
      ),
    );

    refreshCompleter.complete();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 90));

    final closingTop = tester.getTopLeft(listFinder).dy;
    expect(closingTop, greaterThan(restingTop));
    expect(closingTop, lessThan(loadingTop));

    await tester.pumpAndSettle();
    expect(tester.getTopLeft(listFinder).dy, closeTo(restingTop, 1));
    expect(markFinder, findsNothing);
  });

  testWidgets('reveals and arms the mark across an active pull', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(420, 912);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final hapticCalls = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
          if (call.method == 'HapticFeedback.vibrate') hapticCalls.add(call);
          return null;
        });
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null),
    );

    const contentKey = ValueKey('pull-content');
    final refreshCompleter = Completer<void>();
    await tester.pumpWidget(
      WidgetHelpers.testable(
        child: BrandRefreshIndicator(
          onRefresh: () => refreshCompleter.future,
          child: ListView(
            children: const [SizedBox(key: contentKey, height: 800)],
          ),
        ),
      ),
    );

    final restingContentTop = tester.getTopLeft(find.byKey(contentKey)).dy;
    final gesture = await tester.startGesture(
      tester.getCenter(find.byType(ListView)),
      pointer: 1,
    );
    await gesture.moveBy(const Offset(0, 12));
    await tester.pump();

    final markFinder = find.byType(FiveDiveMark);
    expect(markFinder, findsNothing);
    expect(
      tester.getTopLeft(find.byKey(contentKey)).dy,
      greaterThan(restingContentTop),
    );

    await gesture.moveBy(const Offset(0, 44));
    await tester.pump();

    final earlyTop = tester.getTopLeft(markFinder).dy;
    final partialOpacity = tester.widget<Opacity>(
      find.byKey(const ValueKey('brand-refresh-opacity')),
    );
    expect(partialOpacity.opacity, greaterThan(0));
    expect(partialOpacity.opacity, lessThan(1));
    final partialScale = tester
        .widget<Transform>(find.byKey(const ValueKey('brand-refresh-scale')))
        .transform
        .storage[0];
    expect(partialScale, greaterThan(0.6));
    expect(partialScale, lessThan(1));
    expect(hapticCalls, isEmpty);

    await gesture.moveBy(const Offset(0, 120));
    await tester.pump();

    final pulledContentTop = tester.getTopLeft(find.byKey(contentKey)).dy;
    expect(tester.getTopLeft(markFinder).dy, greaterThan(earlyTop));
    final pulledMarkRect = tester.getRect(markFinder);
    final pulledGap = pulledContentTop - restingContentTop;
    expect(
      pulledMarkRect.center.dy,
      closeTo(
        restingContentTop +
            (pulledGap - pulledMarkRect.height) * 0.75 +
            pulledMarkRect.height / 2,
        1,
      ),
    );

    await gesture.moveBy(const Offset(0, 120));
    await tester.pump();

    expect(
      tester
          .widget<Transform>(find.byKey(const ValueKey('brand-refresh-scale')))
          .transform
          .storage[0],
      closeTo(1, 0.001),
    );
    expect(hapticCalls, hasLength(1));
    expect(hapticCalls.single.arguments, 'HapticFeedbackType.mediumImpact');

    // Pulling further does not add a second arm haptic.
    await gesture.moveBy(const Offset(0, 240));
    await tester.pump();
    expect(hapticCalls, hasLength(1));

    await gesture.up();
    await tester.pump();
    refreshCompleter.complete();
    await tester.pumpAndSettle();
  });

  testWidgets('pulses the mark while the refresh is in flight', (tester) async {
    final refreshCompleter = Completer<void>();
    await tester.pumpWidget(
      WidgetHelpers.testable(
        child: BrandRefreshIndicator(
          onRefresh: () => refreshCompleter.future,
          child: ListView(children: const [SizedBox(height: 800)]),
        ),
      ),
    );

    await tester.timedDrag(
      find.byType(ListView),
      const Offset(0, 320),
      const Duration(milliseconds: 500),
    );
    await tester.pump(const Duration(milliseconds: 16));
    await tester.pump(const Duration(milliseconds: 300));

    double scale() => tester
        .widget<Transform>(find.byKey(const ValueKey('brand-refresh-scale')))
        .transform
        .storage[0];

    final first = scale();
    await tester.pump(const Duration(milliseconds: 220));
    final second = scale();
    expect(second, isNot(closeTo(first, 0.005)));
    expect(second, lessThanOrEqualTo(1.0));
    expect(second, greaterThanOrEqualTo(0.88 - 0.001));

    refreshCompleter.complete();
    await tester.pumpAndSettle();
  });

  testWidgets('keeps the mark static when motion is disabled', (tester) async {
    final refreshCompleter = Completer<void>();
    await tester.pumpWidget(
      MediaQuery(
        data: const MediaQueryData(disableAnimations: true),
        child: WidgetHelpers.testable(
          child: Builder(
            builder: (context) => MediaQuery(
              data: MediaQuery.of(context).copyWith(disableAnimations: true),
              child: BrandRefreshIndicator(
                onRefresh: () => refreshCompleter.future,
                child: ListView(children: const [SizedBox(height: 800)]),
              ),
            ),
          ),
        ),
      ),
    );

    await tester.timedDrag(
      find.byType(ListView),
      const Offset(0, 320),
      const Duration(milliseconds: 400),
    );
    await tester.pump(const Duration(milliseconds: 16));
    await tester.pump(const Duration(milliseconds: 300));

    double scale() => tester
        .widget<Transform>(find.byKey(const ValueKey('brand-refresh-scale')))
        .transform
        .storage[0];

    expect(find.byType(FiveDiveMark), findsOneWidget);
    final resting = scale();
    expect(resting, closeTo(1, 0.001));
    await tester.pump(const Duration(milliseconds: 220));
    expect(scale(), closeTo(resting, 0.001));

    refreshCompleter.complete();
    await tester.pumpAndSettle();
  });

  testWidgets('provides elastic always-scrollable physics', (tester) async {
    late ScrollPhysics physics;

    await tester.pumpWidget(
      WidgetHelpers.testable(
        child: BrandRefreshIndicator(
          onRefresh: () async {},
          child: Builder(
            builder: (context) {
              physics = ScrollConfiguration.of(
                context,
              ).getScrollPhysics(context);
              return ListView(children: const [SizedBox(height: 20)]);
            },
          ),
        ),
      ),
    );

    expect(physics, isA<BouncingScrollPhysics>());
    expect(physics.parent, isA<AlwaysScrollableScrollPhysics>());
  });
}
