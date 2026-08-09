import 'dart:ui' as ui;

import 'package:buzz/features/channels/channel_management_provider.dart';
import 'package:buzz/features/channels/message_actions.dart';
import 'package:buzz/features/channels/message_long_press_region.dart';
import 'package:buzz/features/channels/recent_emoji_provider.dart';
import 'package:buzz/shared/read_state/read_state_provider.dart';
import 'package:buzz/features/channels/thread_follows/thread_follows_provider.dart';
import 'package:buzz/features/channels/timeline_message.dart';
import 'package:buzz/shared/emoji/native_emoji_glyph.dart';
import 'package:buzz/shared/reminders/reminder_service.dart';
import 'package:buzz/shared/relay/relay.dart';
import 'package:buzz/shared/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:nostr/nostr.dart' as nostr;
import 'package:shared_preferences/shared_preferences.dart';

const _channelId = 'chan-1';
const _nativeMessageActionSurfaceChannel = MethodChannel(
  'buzz/native_message_action_surface',
);

TimelineMessage _message({
  String id = 'msg-1',
  String pubkey = 'alice',
  int createdAt = 1000,
  bool isSystem = false,
  String? rootId,
  List<TimelineReaction> reactions = const [],
}) => TimelineMessage(
  id: id,
  pubkey: pubkey,
  createdAt: createdAt,
  content: 'hello world',
  isSystem: isSystem,
  rootId: rootId,
  reactions: reactions,
);

class _FakeReadStateNotifier extends ReadStateNotifier {
  final ReadStateState _initialState;
  final Map<String, int> markedRead = {};
  final List<String> markedUnread = [];

  _FakeReadStateNotifier(this._initialState);

  @override
  ReadStateState build() => _initialState;

  @override
  void markContextRead(
    String contextId,
    int unixTimestamp, {
    bool clearForcedMessages = false,
  }) {
    markedRead[contextId] = unixTimestamp;
    var forced = {
      for (final entry in state.forcedUnreadContexts.entries)
        if (entry.key != contextId) entry.key: entry.value,
    };
    if (clearForcedMessages) {
      forced = {
        for (final entry in forced.entries)
          if (entry.value != contextId) entry.key: entry.value,
      };
    }
    state = _withForced(forced).copyWithContext(contextId, unixTimestamp);
  }

  @override
  void markContextUnread(String contextId, {required String channelId}) {
    markedUnread.add(contextId);
    state = _withForced({...state.forcedUnreadContexts, contextId: channelId});
  }

  ReadStateState _withForced(Map<String, String> forced) => ReadStateState(
    isReady: state.isReady,
    pubkey: state.pubkey,
    contexts: state.contexts,
    version: state.version + 1,
    forcedUnreadContexts: Map.unmodifiable(forced),
  );
}

class _RecordingChannelActions extends ChannelActions {
  final List<(String, String)> addedReactions = [];

  _RecordingChannelActions(Ref ref)
    : super(
        ref: ref,
        session: ref.read(relaySessionProvider.notifier),
        signedEventRelay: SignedEventRelay(
          session: ref.read(relaySessionProvider.notifier),
          nsec: null,
        ),
        currentPubkey: 'self',
      );

  @override
  Future<void> addReaction(String eventId, String emoji) async {
    addedReactions.add((eventId, emoji));
  }
}

ReadStateState _readState(Map<String, int> contexts, {bool isReady = true}) =>
    ReadStateState(
      isReady: isReady,
      pubkey: 'self',
      contexts: contexts,
      version: 1,
    );

Future<SharedPreferences> _mockPrefs() async {
  SharedPreferences.setMockInitialValues({});
  return SharedPreferences.getInstance();
}

/// A [ReminderService] whose constructor dependencies are inert until used —
/// enough for visibility checks on the "Remind me" fast action.
ReminderService _stubReminderService() {
  final keys = nostr.Keys.generate();
  return ReminderService(
    signedEventRelay: SignedEventRelay(
      session: RelaySessionNotifier(),
      nsec: keys.nsec,
    ),
    crypto: ReminderCrypto(keys.nsec, keys.public),
  );
}

Future<void> _pumpSheet(
  WidgetTester tester, {
  required TimelineMessage message,
  required SharedPreferences prefs,
  ReadStateNotifier Function()? readStateOverride,
  bool canManageMessage = false,
  List<TimelineMessage>? allMessages,
  ReminderService? reminderService,
  TargetPlatform platform = TargetPlatform.android,
  Rect? anchorRect,
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        savedPrefsProvider.overrideWithValue(prefs),
        myPubkeyProvider.overrideWithValue('self'),
        readStateProvider.overrideWith(
          readStateOverride ??
              () => _FakeReadStateNotifier(
                _readState(const {_channelId: 100000}),
              ),
        ),
        // No signing identity → "Remind me" hidden by default; individual
        // tests opt in by passing a stub service.
        reminderServiceProvider.overrideWithValue(reminderService),
        channelActionsProvider.overrideWith(_RecordingChannelActions.new),
      ],
      child: MaterialApp(
        theme: AppTheme.light().copyWith(platform: platform),
        home: Scaffold(
          body: Consumer(
            builder: (context, ref, _) => TextButton(
              onPressed: () => showMessageActions(
                context: context,
                ref: ref,
                message: message,
                channelId: _channelId,
                canManageMessage: canManageMessage,
                allMessages: allMessages,
                currentPubkey: 'self',
                isMember: true,
                anchorRect: anchorRect,
                captureAnchorSnapshot: anchorRect == null
                    ? null
                    : () async => _testSnapshot(),
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}

Future<void> _pumpImageSheet(
  WidgetTester tester, {
  required TimelineMessage message,
  bool canManageMessage = false,
}) async {
  await tester.pumpWidget(
    ProviderScope(
      child: MaterialApp(
        theme: AppTheme.light(),
        home: Scaffold(
          body: Consumer(
            builder: (context, ref, _) => TextButton(
              onPressed: () => showImageActions(
                context: context,
                ref: ref,
                message: message,
                channelId: _channelId,
                imageUrl: 'https://example.com/photo.png',
                canManageMessage: canManageMessage,
              ),
              child: const Text('open image actions'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open image actions'));
  await tester.pumpAndSettle();
}

ui.Image _testSnapshot() {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  canvas.drawColor(Colors.white, ui.BlendMode.src);
  final picture = recorder.endRecording();
  final image = picture.toImageSync(300, 72);
  picture.dispose();
  return image;
}

class _IosPopoverHarness {
  final ProviderContainer container;
  final ValueNotifier<bool> popoverPresented;

  const _IosPopoverHarness({
    required this.container,
    required this.popoverPresented,
  });
}

Future<_IosPopoverHarness> _pumpIosPopover(
  WidgetTester tester, {
  required TimelineMessage message,
  required SharedPreferences prefs,
  List<TimelineMessage>? allMessages,
  ReminderService? reminderService,
  Rect anchorRect = const Rect.fromLTWH(32, 260, 300, 72),
  bool settlePresentation = true,
}) async {
  tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
    _nativeMessageActionSurfaceChannel,
    (call) async => call.method == 'isSupported' ? true : null,
  );
  addTearDown(
    () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      _nativeMessageActionSurfaceChannel,
      null,
    ),
  );
  final popoverPresented = ValueNotifier(false);
  addTearDown(popoverPresented.dispose);

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        savedPrefsProvider.overrideWithValue(prefs),
        myPubkeyProvider.overrideWithValue('self'),
        readStateProvider.overrideWith(
          () => _FakeReadStateNotifier(_readState(const {_channelId: 100000})),
        ),
        reminderServiceProvider.overrideWithValue(reminderService),
        channelActionsProvider.overrideWith(_RecordingChannelActions.new),
      ],
      child: MaterialApp(
        theme: AppTheme.light().copyWith(platform: TargetPlatform.iOS),
        home: Scaffold(
          body: Consumer(
            builder: (context, ref, _) {
              return TextButton(
                key: const ValueKey('open-ios-popover'),
                onPressed: () => showMessageActions(
                  context: context,
                  ref: ref,
                  message: message,
                  channelId: _channelId,
                  canManageMessage: false,
                  allMessages: allMessages,
                  currentPubkey: 'self',
                  isMember: true,
                  anchorRect: anchorRect,
                  captureAnchorSnapshot: () async => _testSnapshot(),
                  onPopoverPresented: () => popoverPresented.value = true,
                  onPopoverDismissed: () => popoverPresented.value = false,
                ),
                child: const Text('open iOS actions'),
              );
            },
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey('open-ios-popover')));
  if (settlePresentation) {
    await tester.pumpAndSettle();
  } else {
    for (var index = 0; index < 6; index++) {
      await tester.pump();
    }
  }
  final container = ProviderScope.containerOf(
    tester.element(find.byKey(const ValueKey('open-ios-popover'))),
  );
  return _IosPopoverHarness(
    container: container,
    popoverPresented: popoverPresented,
  );
}

Future<void> _dismissIosPopover(WidgetTester tester) async {
  Navigator.of(
    tester.element(
      find.byKey(const ValueKey('ios-native-message-action-surface')),
    ),
  ).pop();
  await tester.pumpAndSettle();
}

Iterable<String> _nativeActionTitles() => find
    .byWidgetPredicate(
      (widget) =>
          widget.key is ValueKey<String> &&
          (widget.key! as ValueKey<String>).value.startsWith(
            'ios-native-action-',
          ),
    )
    .evaluate()
    .map((element) => (element.widget as ListTile).title as Text)
    .map((text) => text.data!);

void main() {
  testWidgets(
    'message long press keeps taps and scrolling while repeated holds win',
    (tester) async {
      var parentTaps = 0;
      var nestedTaps = 0;
      var longPresses = 0;
      final scrollController = ScrollController();
      addTearDown(scrollController.dispose);

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              controller: scrollController,
              child: Column(
                children: [
                  Material(
                    child: MessageLongPressInkWell(
                      key: const ValueKey('parent-gesture-target'),
                      onTap: () => parentTaps += 1,
                      onLongPress: (_) => longPresses += 1,
                      child: const SizedBox(height: 80, width: 300),
                    ),
                  ),
                  Material(
                    child: MessageLongPressInkWell(
                      onLongPress: (_) => longPresses += 1,
                      child: GestureDetector(
                        key: const ValueKey('nested-gesture-target'),
                        behavior: HitTestBehavior.opaque,
                        onTap: () => nestedTaps += 1,
                        child: const SizedBox(height: 80, width: 300),
                      ),
                    ),
                  ),
                  const SizedBox(height: 900),
                ],
              ),
            ),
          ),
        ),
      );

      await tester.tap(find.byKey(const ValueKey('parent-gesture-target')));
      await tester.tap(find.byKey(const ValueKey('nested-gesture-target')));
      await tester.pump();
      expect(parentTaps, 1);
      expect(nestedTaps, 1);

      for (var index = 0; index < 5; index++) {
        await tester.longPress(
          find.byKey(const ValueKey('nested-gesture-target')),
        );
        await tester.pump();
        expect(longPresses, index + 1);
        expect(nestedTaps, 1);
      }

      final drag = await tester.startGesture(
        tester.getCenter(find.byKey(const ValueKey('parent-gesture-target'))),
      );
      await drag.moveBy(const Offset(0, -30));
      await tester.pump();
      await drag.moveBy(const Offset(0, -70));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
      await drag.up();
      await tester.pumpAndSettle();

      expect(longPresses, 5);
      expect(scrollController.offset, greaterThan(0));
    },
  );

  group('showMessageActions', () {
    testWidgets(
      'Android composes the existing tray, lifted preview, and curved actions',
      (tester) async {
        final prefs = await _mockPrefs();
        await _pumpSheet(
          tester,
          message: _message(),
          prefs: prefs,
          canManageMessage: true,
          allMessages: [_message()],
          reminderService: _stubReminderService(),
          anchorRect: const Rect.fromLTWH(32, 260, 300, 72),
        );

        expect(
          find.byKey(const ValueKey('reaction-popover-tray')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('message-action-preview-container')),
          findsOneWidget,
        );
        final surface = find.byKey(
          const ValueKey('android-message-action-surface'),
        );
        expect(surface, findsOneWidget);
        expect(find.byType(BottomSheet), findsNothing);

        const actionIds = [
          'reply',
          'copyLink',
          'remind',
          'markUnread',
          'followThread',
          'copyText',
          'edit',
          'delete',
        ];
        const actionTitles = [
          'Reply',
          'Copy link',
          'Remind me',
          'Mark unread',
          'Follow thread',
          'Copy text',
          'Edit message',
          'Delete message',
        ];
        for (var index = 0; index < actionIds.length; index++) {
          expect(
            find.byKey(ValueKey('android-message-action-${actionIds[index]}')),
            findsOneWidget,
          );
          expect(
            tester
                .widget<Text>(
                  find.byKey(
                    ValueKey(
                      'android-message-action-label-${actionIds[index]}',
                    ),
                  ),
                )
                .data,
            actionTitles[index],
          );
        }

        final surfaceRect = tester.getRect(surface);
        final previewRect = tester.getRect(
          find.byKey(const ValueKey('message-action-preview-container')),
        );
        final trayRect = tester.getRect(
          find.byKey(const ValueKey('reaction-popover-tray')),
        );
        expect(surfaceRect.width, 288);
        expect(surfaceRect.center.dx, closeTo(previewRect.center.dx, 0.01));
        expect(surfaceRect.center.dx, closeTo(trayRect.center.dx, 0.01));
        expect(
          tester.widget<Material>(surface).shape,
          isA<RoundedRectangleBorder>().having(
            (shape) => shape.borderRadius,
            'border radius',
            BorderRadius.circular(26),
          ),
        );
        expect(
          find.byKey(const ValueKey('android-message-action-divider-triage')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('android-message-action-divider-export')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('android-message-action-divider-manage')),
          findsOneWidget,
        );

        final iconCenters = [
          for (final id in actionIds)
            tester
                .getRect(
                  find.byKey(ValueKey('android-message-action-icon-$id')),
                )
                .center
                .dx,
        ];
        final labelLefts = [
          for (final id in actionIds)
            tester
                .getRect(
                  find.byKey(ValueKey('android-message-action-label-$id')),
                )
                .left,
        ];
        for (final center in iconCenters.skip(1)) {
          expect(center, closeTo(iconCenters.first, 0.01));
        }
        for (final left in labelLefts.skip(1)) {
          expect(left, closeTo(labelLefts.first, 0.01));
        }

        Navigator.of(tester.element(surface)).pop();
        await tester.pumpAndSettle();
      },
    );

    testWidgets('Android runs its selected action after dismissing the menu', (
      tester,
    ) async {
      final prefs = await _mockPrefs();
      await _pumpSheet(
        tester,
        message: _message(rootId: 'android-root'),
        prefs: prefs,
        anchorRect: const Rect.fromLTWH(32, 260, 300, 72),
      );
      final container = ProviderScope.containerOf(
        tester.element(find.text('open')),
      );

      await tester.tap(
        find.byKey(const ValueKey('android-message-action-followThread')),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('android-message-action-surface')),
        findsNothing,
      );
      expect(container.read(threadFollowsProvider).followedRootIds, {
        'android-root',
      });
    });

    testWidgets(
      'composes the Flutter tray, lifted preview, and native actions',
      (tester) async {
        final prefs = await _mockPrefs();
        final harness = await _pumpIosPopover(
          tester,
          message: _message(),
          prefs: prefs,
          allMessages: [_message()],
          reminderService: _stubReminderService(),
        );

        expect(harness.popoverPresented.value, isTrue);
        expect(
          find.byKey(const ValueKey('reaction-popover-tray')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('message-action-preview-container')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('ios-native-message-action-surface')),
          findsOneWidget,
        );
        expect(find.byType(BottomSheet), findsNothing);
        expect(_nativeActionTitles(), [
          'Reply',
          'Copy link',
          'Remind me',
          'Mark unread',
          'Follow thread',
          'Copy text',
        ]);

        await _dismissIosPopover(tester);
      },
    );

    testWidgets('uses a compact independently centered action surface', (
      tester,
    ) async {
      final prefs = await _mockPrefs();
      await _pumpIosPopover(
        tester,
        message: _message(),
        prefs: prefs,
        allMessages: [_message()],
      );

      final surfaceRect = tester.getRect(
        find.byKey(const ValueKey('ios-native-message-action-surface')),
      );
      final previewRect = tester.getRect(
        find.byKey(const ValueKey('message-action-preview-container')),
      );
      final previewImageRect = tester.getRect(
        find.descendant(
          of: find.byKey(const ValueKey('message-action-preview-container')),
          matching: find.byType(RawImage),
        ),
      );
      final trayRect = tester.getRect(
        find.byKey(const ValueKey('reaction-popover-tray')),
      );

      expect(surfaceRect.width, 288);
      expect(surfaceRect.height, 231);
      expect(previewRect.size, const Size(316, 88));
      expect(previewImageRect.left - previewRect.left, 8);
      expect(previewImageRect.top - previewRect.top, 8);
      expect(previewRect.right - previewImageRect.right, 8);
      expect(previewRect.bottom - previewImageRect.bottom, 8);
      expect(previewRect.top - trayRect.bottom, Grid.twelve);
      expect(surfaceRect.center.dx, closeTo(previewRect.center.dx, 0.01));
      expect(surfaceRect.center.dx, closeTo(trayRect.center.dx, 0.01));
      expect(surfaceRect.width, lessThan(previewRect.width));

      await _dismissIosPopover(tester);
    });

    testWidgets('reaction-only tray matches the composed message spacing', (
      tester,
    ) async {
      const anchorRect = Rect.fromLTWH(32, 260, 300, 72);
      final prefs = await _mockPrefs();
      await _pumpSheet(
        tester,
        message: _message(isSystem: true),
        prefs: prefs,
        anchorRect: anchorRect,
      );

      final trayRect = tester.getRect(
        find.byKey(const ValueKey('reaction-popover-tray')),
      );
      expect(anchorRect.top - trayRect.bottom, Grid.twelve);
    });

    testWidgets(
      'iOS reaction-only messages lift the preview without an action surface',
      (tester) async {
        final prefs = await _mockPrefs();
        await _pumpSheet(
          tester,
          message: _message(isSystem: true),
          prefs: prefs,
          platform: TargetPlatform.iOS,
          anchorRect: const Rect.fromLTWH(32, 260, 300, 72),
        );

        expect(
          find.byKey(const ValueKey('reaction-popover-tray')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('message-action-preview-container')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('ios-native-message-action-surface')),
          findsNothing,
        );
        expect(find.byType(BottomSheet), findsNothing);
        final trayRect = tester.getRect(
          find.byKey(const ValueKey('reaction-popover-tray')),
        );
        final previewRect = tester.getRect(
          find.byKey(const ValueKey('message-action-preview-container')),
        );
        expect(previewRect.top - trayRect.bottom, Grid.twelve);
        expect(trayRect.center.dx, closeTo(previewRect.center.dx, 0.01));
        expect(
          (trayRect.top + previewRect.bottom) / 2,
          closeTo(
            tester.view.physicalSize.height / tester.view.devicePixelRatio / 2,
            0.01,
          ),
        );

        Navigator.of(
          tester.element(
            find.byKey(const ValueKey('message-action-preview-container')),
          ),
        ).pop();
        await tester.pumpAndSettle();
      },
    );

    testWidgets('popover uses contiguous transparent reaction hit targets', (
      tester,
    ) async {
      final prefs = await _mockPrefs();
      await _pumpIosPopover(tester, message: _message(), prefs: prefs);

      final targets = find.byWidgetPredicate(
        (widget) =>
            widget.key is ValueKey<String> &&
            (widget.key! as ValueKey<String>).value.startsWith(
              'quick-reaction-',
            ),
      );
      final targetKeys = [
        for (final element in targets.evaluate()) element.widget.key!,
      ];
      final targetRects = [
        for (final key in targetKeys) tester.getRect(find.byKey(key)),
      ];
      final trayRect = tester.getRect(
        find.byKey(const ValueKey('reaction-popover-tray')),
      );

      expect(targetRects, hasLength(6));
      for (final rect in targetRects) {
        expect(rect.size.width, greaterThanOrEqualTo(44));
        expect(rect.size.height, greaterThanOrEqualTo(44));
      }
      for (var index = 0; index < targetRects.length - 1; index++) {
        expect(
          targetRects[index + 1].left - targetRects[index].right,
          closeTo(0, 0.01),
        );
      }
      expect(targetRects.first.left - trayRect.left, Grid.xxs);
      expect(trayRect.right - targetRects.last.right, Grid.xxs);
      expect(
        trayRect.width,
        targetRects.last.right - targetRects.first.left + (Grid.xxs * 2),
      );
      expect(
        tester
            .widget<NativeEmojiGlyph>(
              find.descendant(
                of: find.byKey(const ValueKey('quick-reaction-\u{1F44D}')),
                matching: find.byType(NativeEmojiGlyph),
              ),
            )
            .size,
        28,
      );
      final addReactionIcon = tester.widget<Icon>(
        find.descendant(
          of: find.byKey(const ValueKey('quick-reaction-more')),
          matching: find.byType(Icon),
        ),
      );
      expect(addReactionIcon.icon, LucideIcons.smilePlus);
      expect(addReactionIcon.size, 24);
      for (final key in targetKeys) {
        final target = find.byKey(key);
        expect(
          tester
              .widget<Material>(
                find.descendant(of: target, matching: find.byType(Material)),
              )
              .color,
          Colors.transparent,
        );
        final inkWell = tester.widget<InkWell>(
          find.descendant(of: target, matching: find.byType(InkWell)),
        );
        expect(inkWell.highlightColor, isNot(Colors.transparent));
        expect(inkWell.splashColor, isNot(Colors.transparent));
      }

      await _dismissIosPopover(tester);
    });

    testWidgets('popover does not persist selected reaction feedback', (
      tester,
    ) async {
      final prefs = await _mockPrefs();
      await _pumpIosPopover(
        tester,
        message: _message(
          reactions: const [
            TimelineReaction(
              emoji: '\u{1F44D}',
              count: 1,
              reactedByCurrentUser: true,
              userPubkeys: ['self'],
              currentUserReactionId: 'reaction-1',
            ),
          ],
        ),
        prefs: prefs,
      );

      final selectedTarget = find.byKey(
        const ValueKey('quick-reaction-\u{1F44D}'),
      );
      expect(
        tester
            .widget<Material>(
              find.descendant(
                of: selectedTarget,
                matching: find.byType(Material),
              ),
            )
            .color,
        Colors.transparent,
      );

      await _dismissIosPopover(tester);
    });

    testWidgets('popover reactions do not reorder the quick-reaction ranking', (
      tester,
    ) async {
      final prefs = await _mockPrefs();
      final harness = await _pumpIosPopover(
        tester,
        message: _message(),
        prefs: prefs,
      );
      expect(harness.container.read(recentEmojiProvider), isEmpty);

      await tester.tap(find.byKey(const ValueKey('quick-reaction-\u{1F44D}')));
      await tester.pumpAndSettle();

      expect(harness.container.read(recentEmojiProvider), isEmpty);
      expect(
        (harness.container.read(channelActionsProvider)
                as _RecordingChannelActions)
            .addedReactions,
        const [('msg-1', '\u{1F44D}')],
      );
    });

    testWidgets('restores its source after the composed popover dismisses', (
      tester,
    ) async {
      final prefs = await _mockPrefs();
      final harness = await _pumpIosPopover(
        tester,
        message: _message(),
        prefs: prefs,
        allMessages: [_message()],
      );
      expect(harness.popoverPresented.value, isTrue);
      await _dismissIosPopover(tester);
      expect(harness.popoverPresented.value, isFalse);
    });

    testWidgets('combined reaction tray expands right from a fixed left edge', (
      tester,
    ) async {
      final prefs = await _mockPrefs();
      await _pumpIosPopover(
        tester,
        message: _message(),
        prefs: prefs,
        settlePresentation: false,
      );

      await tester.pump(const Duration(milliseconds: 60));
      final tray = find.byKey(const ValueKey('reaction-popover-tray'));
      final firstLeft = tester.getTopLeft(tray).dx;
      final firstWidth = tester.getSize(tray).width;

      await tester.pump(const Duration(milliseconds: 80));
      final secondLeft = tester.getTopLeft(tray).dx;
      final secondWidth = tester.getSize(tray).width;

      expect(secondLeft, closeTo(firstLeft, 0.01));
      expect(secondWidth, greaterThan(firstWidth));
      await tester.pumpAndSettle();
      await _dismissIosPopover(tester);
    });

    testWidgets('runs a selected native action after the popover dismisses', (
      tester,
    ) async {
      final prefs = await _mockPrefs();
      final harness = await _pumpIosPopover(
        tester,
        message: _message(rootId: 'root-9'),
        prefs: prefs,
      );

      await tester.tap(
        find.byKey(const ValueKey('ios-native-action-followThread')),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('reaction-popover-tray')), findsNothing);
      expect(harness.container.read(threadFollowsProvider).followedRootIds, {
        'root-9',
      });
    });

    testWidgets('can reopen the composed iOS message actions', (tester) async {
      final prefs = await _mockPrefs();
      await _pumpIosPopover(tester, message: _message(), prefs: prefs);

      await _dismissIosPopover(tester);
      await tester.tap(find.byKey(const ValueKey('open-ios-popover')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('ios-native-message-action-surface')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('reaction-popover-tray')),
        findsOneWidget,
      );
      await _dismissIosPopover(tester);
    });

    testWidgets('falls back to the Flutter sheet on older iOS versions', (
      tester,
    ) async {
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        _nativeMessageActionSurfaceChannel,
        (call) async => call.method == 'isSupported' ? false : null,
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          _nativeMessageActionSurfaceChannel,
          null,
        ),
      );
      final prefs = await _mockPrefs();

      await _pumpSheet(
        tester,
        message: _message(),
        prefs: prefs,
        platform: TargetPlatform.iOS,
        anchorRect: const Rect.fromLTWH(32, 260, 300, 72),
      );

      expect(find.byType(BottomSheet), findsOneWidget);
      expect(find.text('Copy text'), findsOneWidget);
      expect(find.byKey(const ValueKey('reaction-popover-tray')), findsNothing);
    });

    testWidgets('shows parity actions for a regular message', (tester) async {
      final prefs = await _mockPrefs();
      await _pumpSheet(tester, message: _message(), prefs: prefs);

      expect(find.text('Copy text'), findsOneWidget);
      expect(find.text('Copy link'), findsOneWidget);
      expect(find.text('Mark unread'), findsOneWidget);
      expect(find.text('Follow thread'), findsOneWidget);
      // No thread context → no Reply fast action.
      expect(find.text('Reply'), findsNothing);
      // No signing identity → no reminders; no manage rights → no edit/delete.
      expect(find.text('Remind me'), findsNothing);
      expect(find.text('Edit message'), findsNothing);
      expect(find.text('Delete message'), findsNothing);
      expect(find.byTooltip('Close sheet'), findsNothing);
      expect(find.byKey(const ValueKey('quick-reaction-more')), findsOneWidget);
      expect(
        find.byWidgetPredicate(
          (widget) =>
              widget.key is ValueKey<String> &&
              (widget.key! as ValueKey<String>).value.startsWith(
                'quick-reaction-',
              ),
        ),
        findsNWidgets(6),
      );
      expect(
        tester.getSize(find.byKey(const ValueKey('quick-reaction-\u{1F44D}'))),
        const Size.square(52),
      );
      expect(
        tester
            .widget<Material>(
              find.descendant(
                of: find.byKey(const ValueKey('quick-reaction-\u{1F44D}')),
                matching: find.byType(Material),
              ),
            )
            .color,
        isNot(Colors.transparent),
      );
    });

    testWidgets('existing sheet still updates the quick-reaction ranking', (
      tester,
    ) async {
      final prefs = await _mockPrefs();
      await _pumpSheet(tester, message: _message(), prefs: prefs);
      final container = ProviderScope.containerOf(
        tester.element(find.text('open')),
      );
      expect(container.read(recentEmojiProvider), isEmpty);

      await tester.tap(
        find.byKey(const ValueKey('quick-reaction-\u{2764}\u{FE0F}')),
      );
      await tester.pumpAndSettle();

      expect(container.read(recentEmojiProvider).map((entry) => entry.emoji), [
        '\u{2764}\u{FE0F}',
      ]);
    });

    testWidgets('promotes Reply, Copy link, and Remind me to the fast-actions '
        'row', (tester) async {
      final prefs = await _mockPrefs();
      await _pumpSheet(
        tester,
        message: _message(),
        prefs: prefs,
        allMessages: [_message()],
        reminderService: _stubReminderService(),
      );

      expect(find.text('Reply'), findsOneWidget);
      expect(find.text('Copy link'), findsOneWidget);
      expect(find.text('Remind me'), findsOneWidget);
      // Promoted actions no longer appear under their old list-row labels.
      expect(find.text('Reply in thread'), findsNothing);
      expect(find.text('Remind me later'), findsNothing);
    });

    testWidgets('hides utility actions for system messages', (tester) async {
      final prefs = await _mockPrefs();
      await _pumpSheet(tester, message: _message(isSystem: true), prefs: prefs);

      expect(find.text('Copy text'), findsNothing);
      expect(find.text('Copy link'), findsNothing);
      expect(find.text('Mark unread'), findsNothing);
      expect(find.text('Follow thread'), findsNothing);
      expect(find.text('Reply'), findsNothing);
      expect(find.text('Remind me'), findsNothing);
      expect(find.byTooltip('Close sheet'), findsNothing);
      expect(
        find.byWidgetPredicate(
          (widget) =>
              widget.key is ValueKey<String> &&
              (widget.key! as ValueKey<String>).value.startsWith(
                'quick-reaction-',
              ),
        ),
        findsNWidgets(6),
      );
    });

    testWidgets('keeps six reaction targets within a narrow phone', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(375, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final prefs = await _mockPrefs();

      await _pumpSheet(tester, message: _message(), prefs: prefs);

      expect(
        find.byWidgetPredicate(
          (widget) =>
              widget.key is ValueKey<String> &&
              (widget.key! as ValueKey<String>).value.startsWith(
                'quick-reaction-',
              ),
        ),
        findsNWidgets(6),
      );
      expect(
        tester
            .getSize(find.byKey(const ValueKey('quick-reaction-\u{1F44D}')))
            .width,
        inInclusiveRange(44, 52),
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('keeps the reaction popover on-screen when neither side fits', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(320, 240);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      const anchorRect = Rect.fromLTWH(40, 60, 240, 100);
      const safeTop = 24.0;
      const visibleBottom = 200.0;
      const trayHeight = 68.0;
      const trayGap = Grid.xxs;
      final prefs = await _mockPrefs();
      expect(anchorRect.top - trayGap - trayHeight, lessThan(safeTop));
      expect(
        anchorRect.bottom + trayGap + trayHeight,
        greaterThan(visibleBottom),
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [savedPrefsProvider.overrideWithValue(prefs)],
          child: MaterialApp(
            theme: AppTheme.light(),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context).copyWith(
                padding: const EdgeInsets.only(top: safeTop),
                viewInsets: const EdgeInsets.only(bottom: 40),
              ),
              child: child!,
            ),
            home: Scaffold(
              body: Consumer(
                builder: (context, ref, _) => TextButton(
                  onPressed: () => showMessageActions(
                    context: context,
                    ref: ref,
                    message: _message(isSystem: true),
                    channelId: _channelId,
                    canManageMessage: false,
                    anchorRect: anchorRect,
                  ),
                  child: const Text('open popover'),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open popover'));
      await tester.pumpAndSettle();

      final trayRect = tester.getRect(
        find.byKey(const ValueKey('reaction-popover-tray')),
      );
      expect(trayRect.top, greaterThanOrEqualTo(safeTop));
      expect(trayRect.bottom, lessThanOrEqualTo(visibleBottom));
    });

    testWidgets('shows Edit/Delete only with manage rights', (tester) async {
      final prefs = await _mockPrefs();
      await _pumpSheet(
        tester,
        message: _message(),
        prefs: prefs,
        canManageMessage: true,
      );

      expect(find.text('Edit message'), findsOneWidget);
      expect(find.text('Delete message'), findsOneWidget);
    });

    testWidgets('Mark read appears for unread messages and advances the '
        'message marker', (tester) async {
      final prefs = await _mockPrefs();
      final notifier = _FakeReadStateNotifier(
        _readState(const {_channelId: 500}),
      );
      await _pumpSheet(
        tester,
        message: _message(createdAt: 900),
        prefs: prefs,
        readStateOverride: () => notifier,
      );

      expect(find.text('Mark read'), findsOneWidget);
      await tester.tap(find.text('Mark read'));
      await tester.pumpAndSettle();

      expect(notifier.markedRead, {'msg:msg-1': 900});
    });

    testWidgets('Mark unread forces the message unread', (tester) async {
      final prefs = await _mockPrefs();
      final notifier = _FakeReadStateNotifier(
        _readState(const {_channelId: 2000}),
      );
      await _pumpSheet(
        tester,
        message: _message(createdAt: 900),
        prefs: prefs,
        readStateOverride: () => notifier,
      );

      expect(find.text('Mark unread'), findsOneWidget);
      await tester.tap(find.text('Mark unread'));
      await tester.pumpAndSettle();

      // The force flag is message-scoped, mapped to its channel so tiles and
      // badges surface it.
      expect(notifier.markedUnread, ['msg:msg-1']);
      expect(notifier.state.forcedUnreadContexts, {'msg:msg-1': _channelId});
      expect(notifier.state.locallyForcedChannelIds, {_channelId});
    });

    testWidgets('Mark read after a forced unread clears the force flag so '
        'the toggle round-trips', (tester) async {
      final prefs = await _mockPrefs();
      final notifier = _FakeReadStateNotifier(
        _readState(const {_channelId: 2000}),
      );
      await _pumpSheet(
        tester,
        message: _message(createdAt: 900),
        prefs: prefs,
        readStateOverride: () => notifier,
      );

      // Force the message unread; the row flips to Mark read.
      await tester.tap(find.text('Mark unread'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text('Mark read'), findsOneWidget);

      // Mark read must clear the message's own force flag — otherwise the
      // row sticks on "Mark read".
      await tester.tap(find.text('Mark read'));
      await tester.pumpAndSettle();

      final container = ProviderScope.containerOf(
        tester.element(find.text('open')),
      );
      expect(container.read(readStateProvider).forcedUnreadContexts, isEmpty);

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text('Mark unread'), findsOneWidget);
      expect(find.text('Mark read'), findsNothing);
    });

    testWidgets('message-level Mark read leaves a channel-level forced '
        'unread untouched', (tester) async {
      final prefs = await _mockPrefs();
      final notifier = _FakeReadStateNotifier(
        ReadStateState(
          isReady: true,
          pubkey: 'self',
          contexts: const {_channelId: 2000},
          version: 1,
          // Channel forced unread from the channel tile, message forced
          // unread from this sheet.
          forcedUnreadContexts: const {
            _channelId: _channelId,
            'msg:msg-1': _channelId,
          },
        ),
      );
      await _pumpSheet(
        tester,
        message: _message(createdAt: 900),
        prefs: prefs,
        readStateOverride: () => notifier,
      );

      expect(find.text('Mark read'), findsOneWidget);
      await tester.tap(find.text('Mark read'));
      await tester.pumpAndSettle();

      // The message's flag is gone; the user's channel-level choice stays.
      final readState = notifier.state;
      expect(readState.forcedUnreadContexts, {_channelId: _channelId});
      expect(readState.locallyForcedChannelIds, {_channelId});
    });

    testWidgets('hides read-state row while read state is not ready', (
      tester,
    ) async {
      final prefs = await _mockPrefs();
      await _pumpSheet(
        tester,
        message: _message(),
        prefs: prefs,
        readStateOverride: () =>
            _FakeReadStateNotifier(_readState(const {}, isReady: false)),
      );

      expect(find.text('Mark unread'), findsNothing);
      expect(find.text('Mark read'), findsNothing);
    });

    testWidgets('Follow thread toggles the effective root id', (tester) async {
      final prefs = await _mockPrefs();
      await _pumpSheet(
        tester,
        message: _message(rootId: 'root-9'),
        prefs: prefs,
      );

      await tester.tap(find.text('Follow thread'));
      await tester.pumpAndSettle();

      final container = ProviderScope.containerOf(
        tester.element(find.text('open')),
      );
      expect(container.read(threadFollowsProvider).followedRootIds, {'root-9'});

      // Re-open: the row now offers Unfollow.
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text('Unfollow thread'), findsOneWidget);

      await tester.tap(find.text('Unfollow thread'));
      await tester.pumpAndSettle();
      expect(container.read(threadFollowsProvider).followedRootIds, isEmpty);
    });
  });

  group('showImageActions', () {
    testWidgets('labels the destructive action as deleting the message', (
      tester,
    ) async {
      await _pumpImageSheet(
        tester,
        message: _message(),
        canManageMessage: true,
      );

      expect(find.text('Delete message'), findsOneWidget);
      expect(find.text('Delete upload'), findsNothing);
    });
  });

  group('downloadedImageFilename', () {
    test('preserves gif file extensions', () {
      expect(
        downloadedImageFilename('https://example.com/animation.gif', null),
        'animation.gif',
      );
    });

    test('uses gif extension for gif content types', () {
      expect(
        downloadedImageFilename(
          'https://example.com/download',
          'image/gif; charset=binary',
        ),
        matches(RegExp(r'^buzz-\d+\.gif$')),
      );
    });
  });

  group('messageLinkFor', () {
    test('builds a canonical link with thread context', () {
      expect(
        messageLinkFor(
          message: _message(rootId: 'root-1'),
          channelId: _channelId,
        ),
        'buzz://message?channel=chan-1&id=msg-1&thread=root-1',
      );
    });

    test('omits thread for top-level messages', () {
      expect(
        messageLinkFor(message: _message(), channelId: _channelId),
        'buzz://message?channel=chan-1&id=msg-1',
      );
    });
  });
}
