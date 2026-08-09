import 'package:buzz/shared/widgets/ios_native_menu_button.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('serializes native iOS menu item state and grouping', () {
    const item = IosNativeMenuItem(
      id: 'mentions',
      title: 'Mentions',
      systemImage: 'at',
      group: 'inbox',
      checked: true,
      enabled: false,
    );

    expect(item.toPlatformArguments(), {
      'id': 'mentions',
      'title': 'Mentions',
      'systemImage': 'at',
      'group': 'inbox',
      'checked': true,
      'enabled': false,
      'destructive': false,
    });
  });

  testWidgets('keeps its selection callback while menu content updates', (
    tester,
  ) async {
    final previousPlatform = debugDefaultTargetPlatformOverride;
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    const viewId = 74;
    final channel = MethodChannel('buzz/native_menu_button/$viewId');
    final selected = <String>[];
    final checked = ValueNotifier(false);
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      channel,
      (_) async => null,
    );

    try {
      await tester.pumpWidget(
        MaterialApp(
          home: ValueListenableBuilder<bool>(
            valueListenable: checked,
            builder: (context, value, child) => SizedBox(
              width: 120,
              height: 48,
              child: IosNativeMenuButton(
                title: value ? 'Mentions' : 'All',
                accessibilityLabel: 'Filter activity',
                foregroundColor: Colors.black,
                items: [
                  IosNativeMenuItem(
                    id: 'mention',
                    title: 'Mentions',
                    checked: value,
                  ),
                ],
                onSelected: selected.add,
              ),
            ),
          ),
        ),
      );
      final platformView = tester.widget<UiKitView>(find.byType(UiKitView));
      platformView.onPlatformViewCreated?.call(viewId);
      await tester.pump();

      checked.value = true;
      await tester.pump();
      await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
        channel.name,
        channel.codec.encodeMethodCall(
          const MethodCall('selected', {'id': 'mention'}),
        ),
        null,
      );
      await tester.pump();

      expect(selected, ['mention']);
    } finally {
      checked.dispose();
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        channel,
        null,
      );
      debugDefaultTargetPlatformOverride = previousPlatform;
    }
  });
}
