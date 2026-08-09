import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_hooks/flutter_hooks.dart';

const _supportChannel = MethodChannel('buzz/native_menu_button');

/// A single action displayed by an iOS system menu.
class IosNativeMenuItem {
  final String id;
  final String title;
  final String? systemImage;
  final String group;
  final bool checked;
  final bool enabled;
  final bool destructive;

  const IosNativeMenuItem({
    required this.id,
    required this.title,
    this.systemImage,
    this.group = 'primary',
    this.checked = false,
    this.enabled = true,
    this.destructive = false,
  });

  Map<String, Object?> toPlatformArguments() => {
    'id': id,
    'title': title,
    if (systemImage != null) 'systemImage': systemImage,
    'group': group,
    'checked': checked,
    'enabled': enabled,
    'destructive': destructive,
  };
}

/// A native UIButton whose primary action opens a UIKit UIMenu.
///
/// Call [isSupported] before building this widget. Android and older iOS
/// versions should retain their existing Flutter menu trigger.
class IosNativeMenuButton extends HookWidget {
  final String? title;
  final String? systemImage;
  final String accessibilityLabel;
  final Color foregroundColor;
  final List<IosNativeMenuItem> items;
  final ValueChanged<String> onSelected;

  const IosNativeMenuButton({
    super.key,
    this.title,
    this.systemImage,
    required this.accessibilityLabel,
    required this.foregroundColor,
    required this.items,
    required this.onSelected,
  });

  static Future<bool> isSupported() async {
    if (defaultTargetPlatform != TargetPlatform.iOS) return false;
    try {
      return await _supportChannel.invokeMethod<bool>('isSupported') ?? false;
    } on MissingPluginException {
      return false;
    } on PlatformException {
      return false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final viewId = useState<int?>(null);
    final onSelectedRef = useRef(onSelected)..value = onSelected;
    final arguments = <String, Object?>{
      if (title != null) 'title': title,
      if (systemImage != null) 'systemImage': systemImage,
      'accessibilityLabel': accessibilityLabel,
      'foregroundColor': foregroundColor.toARGB32(),
      'items': [for (final item in items) item.toPlatformArguments()],
    };
    final itemSignature = Object.hashAll([
      for (final item in items)
        Object.hash(
          item.id,
          item.title,
          item.systemImage,
          item.group,
          item.checked,
          item.enabled,
          item.destructive,
        ),
    ]);

    useEffect(() {
      final id = viewId.value;
      if (id == null) return null;
      final channel = MethodChannel('buzz/native_menu_button/$id');
      channel.setMethodCallHandler((call) async {
        if (call.method != 'selected' || call.arguments is! Map) return;
        final selectedId = (call.arguments as Map)['id'];
        if (selectedId is String) onSelectedRef.value(selectedId);
      });
      return () => channel.setMethodCallHandler(null);
    }, [viewId.value]);

    useEffect(
      () {
        final id = viewId.value;
        if (id == null) return null;
        final channel = MethodChannel('buzz/native_menu_button/$id');
        unawaited(channel.invokeMethod<void>('update', arguments));
        return null;
      },
      [
        viewId.value,
        title,
        systemImage,
        accessibilityLabel,
        foregroundColor.toARGB32(),
        itemSignature,
      ],
    );

    return UiKitView(
      viewType: 'buzz/native_menu_button',
      creationParams: arguments,
      creationParamsCodec: const StandardMessageCodec(),
      onPlatformViewCreated: (id) => viewId.value = id,
    );
  }
}
