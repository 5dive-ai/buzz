import 'dart:async';
import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/physics.dart';
import 'package:flutter/services.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:path_provider/path_provider.dart';
import 'package:photo_manager/photo_manager.dart';
import 'package:share_plus/share_plus.dart';

import '../../shared/clipboard_utils.dart';
import '../../shared/deeplink/deep_link.dart';
import '../../shared/relay/relay.dart';
import '../../shared/theme/theme.dart';
import '../../shared/custom_emoji/custom_emoji.dart';
import '../../shared/custom_emoji/custom_emoji_provider.dart';
import '../../shared/custom_emoji/custom_emoji_render.dart';
import '../../shared/emoji/native_emoji_glyph.dart';
import '../../shared/widgets/sheet_divider.dart';
import '../../shared/widgets/modal_presentation.dart';
import '../../shared/reminders/remind_me_later_sheet.dart';
import '../../shared/reminders/reminder_service.dart';
import 'channel_management_provider.dart';
import 'emoji_picker.dart';
import 'reaction_row.dart';
import 'recent_emoji_provider.dart';
import '../../shared/read_state/message_read_state.dart';
import '../../shared/read_state/read_state_format.dart';
import '../../shared/read_state/read_state_provider.dart';
import 'thread_detail_page.dart';
import 'thread_follows/thread_follows_provider.dart';
import 'timeline_message.dart';

part 'message_actions/reaction_popover.dart';
part 'message_actions/ios_native_message_actions.dart';
part 'message_actions/ios_message_actions_popover.dart';
part 'message_actions/message_actions_sheet.dart';

/// Preview length for reminder targets — matches desktop's
/// `msg.body.slice(0, 100)`.
const _reminderPreviewLength = 100;

void showMessageActions({
  required BuildContext context,
  required WidgetRef ref,
  required TimelineMessage message,
  required String channelId,
  required bool canManageMessage,
  List<TimelineMessage>? allMessages,
  String? currentPubkey,
  bool isMember = false,
  bool isArchived = false,
  Rect? anchorRect,
  Future<ui.Image> Function()? captureAnchorSnapshot,
  EdgeInsets popoverSpotlightPadding = const EdgeInsets.all(Grid.xxs),
  VoidCallback? onPopoverPresented,
  VoidCallback? onPopoverDismissed,
}) {
  final hasReactionOnlyActions = message.isSystem && !canManageMessage;
  if (anchorRect != null && hasReactionOnlyActions) {
    if (Theme.of(context).platform == TargetPlatform.iOS &&
        captureAnchorSnapshot != null) {
      unawaited(
        _showIosReactionOnlyPopover(
          context: context,
          ref: ref,
          message: message,
          anchorRect: anchorRect,
          captureAnchorSnapshot: captureAnchorSnapshot,
          spotlightPadding: popoverSpotlightPadding,
          onPopoverPresented: onPopoverPresented,
          onPopoverDismissed: onPopoverDismissed,
        ).then((shown) {
          if (shown || !context.mounted) return;
          _showMessageReactionPopover(
            context: context,
            ref: ref,
            message: message,
            anchorRect: anchorRect,
            spotlightPadding: popoverSpotlightPadding,
          );
        }),
      );
      return;
    }
    _showMessageReactionPopover(
      context: context,
      ref: ref,
      message: message,
      anchorRect: anchorRect,
      spotlightPadding: popoverSpotlightPadding,
    );
    return;
  }

  if (anchorRect != null &&
      Theme.of(context).platform == TargetPlatform.iOS &&
      captureAnchorSnapshot != null) {
    unawaited(
      _showIosMessageActionsPopover(
        context: context,
        ref: ref,
        message: message,
        channelId: channelId,
        canManageMessage: canManageMessage,
        allMessages: allMessages,
        currentPubkey: currentPubkey,
        isMember: isMember,
        isArchived: isArchived,
        anchorRect: anchorRect,
        captureAnchorSnapshot: captureAnchorSnapshot,
        spotlightPadding: popoverSpotlightPadding,
        onPopoverPresented: onPopoverPresented,
        onPopoverDismissed: onPopoverDismissed,
      ).then((shown) {
        if (shown || !context.mounted) return;
        _showMessageActionsSheet(
          context: context,
          ref: ref,
          message: message,
          channelId: channelId,
          canManageMessage: canManageMessage,
          allMessages: allMessages,
          currentPubkey: currentPubkey,
          isMember: isMember,
          isArchived: isArchived,
        );
      }),
    );
    return;
  }

  _showMessageActionsSheet(
    context: context,
    ref: ref,
    message: message,
    channelId: channelId,
    canManageMessage: canManageMessage,
    allMessages: allMessages,
    currentPubkey: currentPubkey,
    isMember: isMember,
    isArchived: isArchived,
  );
}

/// Image-focused actions shown from the full-screen viewer.
void showImageActions({
  required BuildContext context,
  required WidgetRef ref,
  required TimelineMessage message,
  required String channelId,
  required String imageUrl,
  required bool canManageMessage,
  VoidCallback? onDeleted,
}) {
  showBuzzModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (sheetContext) => SafeArea(
      child: IconTheme.merge(
        data: const IconThemeData(size: 22),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            Grid.gutter,
            0,
            Grid.gutter,
            Grid.xs,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(LucideIcons.download),
                title: const Text('Save image'),
                onTap: () {
                  Navigator.of(sheetContext).pop();
                  unawaited(_saveImage(context, ref, imageUrl));
                },
              ),
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(LucideIcons.share2),
                title: const Text('Share image'),
                onTap: () {
                  final renderBox = context.findRenderObject() as RenderBox?;
                  final shareOrigin = renderBox == null
                      ? null
                      : renderBox.localToGlobal(Offset.zero) & renderBox.size;
                  Navigator.of(sheetContext).pop();
                  unawaited(
                    _shareImage(
                      context,
                      ref,
                      imageUrl,
                      shareOrigin: shareOrigin,
                    ),
                  );
                },
              ),
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(LucideIcons.link2),
                title: const Text('Copy image link'),
                onTap: () {
                  Navigator.of(sheetContext).pop();
                  copyToClipboard(
                    context,
                    imageUrl,
                    message: 'Image link copied',
                  );
                },
              ),
              if (canManageMessage) ...[
                const SheetDivider(),
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(
                    LucideIcons.trash2,
                    color: sheetContext.colors.error,
                  ),
                  title: Text(
                    'Delete message',
                    style: TextStyle(color: sheetContext.colors.error),
                  ),
                  onTap: () {
                    Navigator.of(sheetContext).pop();
                    _confirmDelete(
                      context: context,
                      ref: ref,
                      channelId: channelId,
                      messageId: message.id,
                      onDeleted: onDeleted,
                    );
                  },
                ),
              ],
            ],
          ),
        ),
      ),
    ),
  );
}

@immutable
class _DownloadedImage {
  final Uint8List bytes;
  final String filename;

  const _DownloadedImage({required this.bytes, required this.filename});
}

Future<_DownloadedImage> _downloadImage(WidgetRef ref, String imageUrl) async {
  final response = await ref
      .read(mediaHttpClientProvider)
      .get(
        Uri.parse(imageUrl),
        headers: ref.read(mediaGetAuthServiceProvider).headersFor(imageUrl),
      );
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw HttpException(
      'Image download failed (${response.statusCode})',
      uri: Uri.parse(imageUrl),
    );
  }
  return _DownloadedImage(
    bytes: response.bodyBytes,
    filename: downloadedImageFilename(
      imageUrl,
      response.headers['content-type'],
    ),
  );
}

/// Returns a safe image filename while preserving supported image formats.
@visibleForTesting
String downloadedImageFilename(String imageUrl, String? contentType) {
  final pathSegments = Uri.tryParse(imageUrl)?.pathSegments;
  final rawName = pathSegments == null || pathSegments.isEmpty
      ? ''
      : pathSegments.last;
  final safeName = rawName
      .replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '-')
      .replaceAll(RegExp(r'-+'), '-');
  if (RegExp(
    r'\.(avif|bmp|gif|heic|heif|jpe?g|png|webp)$',
    caseSensitive: false,
  ).hasMatch(safeName)) {
    return safeName;
  }
  final extension = switch (contentType?.split(';').first.trim()) {
    'image/avif' => '.avif',
    'image/gif' => '.gif',
    'image/heic' => '.heic',
    'image/heif' => '.heif',
    'image/png' => '.png',
    'image/webp' => '.webp',
    _ => '.jpg',
  };
  return 'buzz-${DateTime.now().millisecondsSinceEpoch}$extension';
}

Future<void> _saveImage(
  BuildContext context,
  WidgetRef ref,
  String imageUrl,
) async {
  final messenger = ScaffoldMessenger.maybeOf(context);
  try {
    final needsPhotoLibraryPermission =
        defaultTargetPlatform == TargetPlatform.iOS ||
        await requiresLegacyMediaStoragePermission();
    if (needsPhotoLibraryPermission) {
      final permission = await PhotoManager.requestPermissionExtend(
        requestOption: const PermissionRequestOption(
          iosAccessLevel: IosAccessLevel.addOnly,
          androidPermission: AndroidPermission(
            type: RequestType.image,
            mediaLocation: false,
          ),
        ),
      );
      if (!permission.isAuth) {
        throw const FileSystemException(
          'Photo library permission was not granted.',
        );
      }
    }
    final image = await _downloadImage(ref, imageUrl);
    await PhotoManager.editor.saveImage(image.bytes, filename: image.filename);
    messenger?.showSnackBar(
      const SnackBar(content: Text('Image saved to Photos')),
    );
  } catch (_) {
    messenger?.showSnackBar(
      const SnackBar(content: Text('Could not save image')),
    );
  }
}

Future<void> _shareImage(
  BuildContext context,
  WidgetRef ref,
  String imageUrl, {
  Rect? shareOrigin,
}) async {
  final messenger = ScaffoldMessenger.maybeOf(context);
  try {
    final image = await _downloadImage(ref, imageUrl);
    final directory = await getTemporaryDirectory();
    final file = File(
      '${directory.path}${Platform.pathSeparator}${image.filename}',
    );
    await file.writeAsBytes(image.bytes, flush: true);
    await SharePlus.instance.share(
      ShareParams(files: [XFile(file.path)], sharePositionOrigin: shareOrigin),
    );
  } catch (_) {
    messenger?.showSnackBar(
      const SnackBar(content: Text('Could not share image')),
    );
  }
}

/// Canonical `buzz://message` link for a timeline message, including thread
/// context when the message is a reply.
String messageLinkFor({
  required TimelineMessage message,
  required String channelId,
}) {
  return buildMessageLink(
    channelId: channelId,
    messageId: message.id,
    threadRootId: message.rootId,
  );
}

class _MarkReadUnreadTile extends ConsumerWidget {
  final TimelineMessage message;
  final String channelId;

  const _MarkReadUnreadTile({required this.message, required this.channelId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final readState = ref.watch(readStateProvider);
    if (!readState.isReady) return const SizedBox.shrink();

    final unread = isMessageUnread(
      readState,
      channelId: channelId,
      messageId: message.id,
      createdAt: message.createdAt,
      threadRootId: message.rootId,
    );

    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Icon(unread ? LucideIcons.mailCheck : LucideIcons.mailOpen),
      title: Text(unread ? 'Mark read' : 'Mark unread'),
      onTap: () {
        Navigator.of(context).pop();
        final notifier = ref.read(readStateProvider.notifier);
        if (unread) {
          // Advances the `msg:` marker and clears this message's own forced
          // flag — a channel-level forced unread (channel tile) is a separate
          // choice and stays untouched.
          notifier.markContextRead(
            msgContextKey(message.id),
            message.createdAt,
          );
        } else {
          // Read markers are monotonic and cannot move backward, so mark
          // unread forces this message unread locally (session-local, does
          // not survive relaunch). The channel surfaces it as unread too.
          notifier.markContextUnread(
            msgContextKey(message.id),
            channelId: channelId,
          );
        }
      },
    );
  }
}

class _FollowThreadTile extends ConsumerWidget {
  final TimelineMessage message;

  const _FollowThreadTile({required this.message});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final follows = ref.watch(threadFollowsProvider);
    // Follow acts on the effective thread root: the root for replies, the
    // message itself for potential thread heads (matches desktop).
    final rootId = message.rootId ?? message.id;
    final following = follows.isFollowing(rootId);

    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Icon(following ? LucideIcons.bellOff : LucideIcons.bellRing),
      title: Text(following ? 'Unfollow thread' : 'Follow thread'),
      onTap: () {
        Navigator.of(context).pop();
        final notifier = ref.read(threadFollowsProvider.notifier);
        if (following) {
          notifier.unfollowThread(rootId);
        } else {
          notifier.followThread(rootId);
        }
      },
    );
  }
}

/// Promoted actions for the three dominant mobile jobs: respond now (Reply),
/// hand off context (Copy link — the `buzz://message` link is the workspace's
/// context-transfer primitive), and defer (Remind me).
class _FastActionsRow extends ConsumerWidget {
  final TimelineMessage message;
  final String channelId;
  final List<TimelineMessage>? allMessages;
  final String? currentPubkey;
  final bool isMember;
  final bool isArchived;

  /// The long-pressed message's page context — survives the sheet pop, used
  /// for the thread push and the copy-link snackbar.
  final BuildContext pageContext;

  const _FastActionsRow({
    required this.message,
    required this.channelId,
    required this.allMessages,
    required this.currentPubkey,
    required this.isMember,
    required this.isArchived,
    required this.pageContext,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final messages = allMessages;
    final canRemind = ref.watch(reminderServiceProvider) != null;

    final tiles = <Widget>[
      if (messages != null)
        _FastActionTile(
          icon: LucideIcons.messageSquareReply,
          label: 'Reply',
          onTap: () {
            Navigator.of(context).pop();
            Navigator.of(pageContext).push(
              MaterialPageRoute<void>(
                builder: (_) => ThreadDetailPage(
                  threadHead: message,
                  allMessages: messages,
                  channelId: channelId,
                  currentPubkey: currentPubkey,
                  isMember: isMember,
                  isArchived: isArchived,
                ),
              ),
            );
          },
        ),
      _FastActionTile(
        icon: LucideIcons.link2,
        label: 'Copy link',
        onTap: () {
          Navigator.of(context).pop();
          copyToClipboard(
            pageContext,
            messageLinkFor(message: message, channelId: channelId),
            message: 'Message link copied',
          );
        },
      ),
      if (canRemind)
        _FastActionTile(
          icon: LucideIcons.clock,
          label: 'Remind me',
          onTap: () {
            final rootContext = Navigator.of(
              context,
              rootNavigator: true,
            ).context;
            Navigator.of(context).pop();
            showRemindMeLaterSheet(
              context: rootContext,
              ref: ref,
              target: ReminderTarget(
                eventId: message.id,
                channelId: channelId,
                preview: message.content.characters
                    .take(_reminderPreviewLength)
                    .toString(),
                authorPubkey: message.pubkey,
              ),
            );
          },
        ),
    ];

    return Row(
      children: [
        for (var index = 0; index < tiles.length; index++) ...[
          Expanded(child: tiles[index]),
          if (index < tiles.length - 1) const SizedBox(width: Grid.twelve),
        ],
      ],
    );
  }
}

class _FastActionTile extends StatelessWidget {
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  const _FastActionTile({
    required this.icon,
    required this.label,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () {
        unawaited(HapticFeedback.lightImpact());
        onTap();
      },
      behavior: HitTestBehavior.opaque,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // The full-width tiles deliberately contrast with the compact emoji
          // reactions immediately above them.
          Container(
            height: 68 + (Grid.xxs * 2),
            decoration: BoxDecoration(
              color: context.colors.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(Radii.dialog),
            ),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(icon, size: 22, color: context.colors.onSurface),
                const SizedBox(height: Grid.xxs),
                Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.textTheme.labelMedium?.copyWith(
                    color: context.colors.onSurface,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The row of one-tap reactions at the top of the action sheet, plus the "+"
/// tile that opens the full picker.
///
/// The emoji shown are the user's own frequently-used set (desktop's
/// `useQuickReactionEmojis` behaviour), topped up with [defaultQuickEmojis] so
/// the row is full on a fresh install.
const _quickReactionEmojiLimit = 5;
const _quickReactionDesiredTargetSize = 52.0;
const _quickReactionMinimumTargetSize = 44.0;
const _quickReactionGlyphSize = 28.0;

class _QuickReactionRow extends ConsumerWidget {
  final TimelineMessage message;

  /// The sheet's context, popped before the reaction fires.
  final BuildContext sheetContext;

  /// The long-pressed message's page context — survives the sheet pop, so the
  /// picker opened from "+" isn't torn down with the sheet.
  final BuildContext pageContext;

  /// The long-pressed message's page ref. The picker callback outlives this
  /// bottom sheet, so it must not read through the sheet's disposed ref.
  final WidgetRef pageRef;

  /// Drives the staged glyph reveal when this row is shown in the popover.
  /// The bottom sheet leaves this null and retains its existing static row.
  final Animation<double>? presentationAnimation;

  const _QuickReactionRow({
    required this.message,
    required this.sheetContext,
    required this.pageContext,
    required this.pageRef,
    this.presentationAnimation,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final usesPopoverTreatment = presentationAnimation != null;
    final customEmoji = ref.watch(customEmojiListProvider);
    final emoji = quickReactionEmoji(
      ref.watch(recentEmojiProvider),
      customShortcodes: {
        for (final entry in customEmoji) entry.shortcode.toLowerCase(),
      },
      limit: _quickReactionEmojiLimit,
    );
    final customByShortcode = {
      for (final entry in customEmoji) entry.shortcode.toLowerCase(): entry,
    };

    void react(String value) {
      // Keep the composed popover's tray stable across repeated opens. The
      // existing sheet continues to update the frequently-used ranking exactly
      // as it did before the iOS presentation was introduced.
      if (!usesPopoverTreatment) {
        pageRef.read(recentEmojiProvider.notifier).record(value);
      }
      // The sheet is on its way out, so the burst can't come from this tile —
      // hand it to the pill that's about to appear in the timeline.
      armReactionBurst(pageRef, message, value);
      pageRef.read(channelActionsProvider).addReaction(message.id, value);
    }

    return LayoutBuilder(
      builder: (context, constraints) {
        final maximumGap = usesPopoverTreatment ? 0.0 : Grid.twelve;
        final itemCount = emoji.length + 1;
        final gapCount = itemCount - 1;
        final circleSize =
            ((constraints.maxWidth - (maximumGap * gapCount)) / itemCount)
                .clamp(
                  _quickReactionMinimumTargetSize,
                  _quickReactionDesiredTargetSize,
                )
                .toDouble();
        final gap =
            ((constraints.maxWidth - (circleSize * itemCount)) / gapCount)
                .clamp(0.0, maximumGap)
                .toDouble();
        final circles = <Widget>[
          for (var index = 0; index < emoji.length; index++)
            _ReactionItemReveal(
              key: ValueKey('quick-reaction-${emoji[index]}'),
              animation: presentationAnimation,
              index: index,
              child: _QuickReactionCircle(
                size: circleSize,
                semanticLabel: emoji[index],
                showIdleBackground: !usesPopoverTreatment,
                onTap: () {
                  Navigator.of(sheetContext).pop();
                  react(emoji[index]);
                },
                child: _QuickReactionGlyph(
                  value: emoji[index],
                  customByShortcode: customByShortcode,
                ),
              ),
            ),
          _ReactionItemReveal(
            key: const ValueKey('quick-reaction-more'),
            animation: presentationAnimation,
            index: emoji.length,
            child: _QuickReactionCircle(
              size: circleSize,
              semanticLabel: 'Add reaction',
              showIdleBackground: !usesPopoverTreatment,
              onTap: () {
                Navigator.of(sheetContext).pop();
                showEmojiPicker(context: pageContext, onSelect: react);
              },
              child: Icon(
                LucideIcons.smilePlus,
                size: 24,
                color: context.colors.onSurfaceVariant,
              ),
            ),
          ),
        ];

        return Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            for (var index = 0; index < circles.length; index++) ...[
              circles[index],
              if (index < circles.length - 1) SizedBox(width: gap),
            ],
          ],
        );
      },
    );
  }
}

class _ReactionItemReveal extends StatelessWidget {
  final Animation<double>? animation;
  final int index;
  final Widget child;

  const _ReactionItemReveal({
    super.key,
    required this.animation,
    required this.index,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    final parent = animation;
    if (parent == null) return child;

    final start = 0.06 + (index * 0.11);
    final opacityEnd = math.min(1.0, start + 0.20);
    final scaleEnd = math.min(1.0, start + 0.30);
    final opacity = CurvedAnimation(
      parent: parent,
      curve: Interval(start, opacityEnd, curve: Curves.easeOutCubic),
    );
    final scale = Tween<double>(begin: 0.86, end: 1).animate(
      CurvedAnimation(
        parent: parent,
        curve: Interval(start, scaleEnd, curve: _reactionSpringCurve),
      ),
    );

    return FadeTransition(
      opacity: opacity,
      child: ScaleTransition(scale: scale, child: child),
    );
  }
}

/// Renders a quick-reaction value: a Unicode glyph as text, a `:shortcode:` as
/// its custom-emoji image.
class _QuickReactionGlyph extends StatelessWidget {
  final String value;
  final Map<String, CustomEmoji> customByShortcode;

  const _QuickReactionGlyph({
    required this.value,
    required this.customByShortcode,
  });

  @override
  Widget build(BuildContext context) {
    if (value.startsWith(':') && value.endsWith(':')) {
      final shortcode = value.substring(1, value.length - 1).toLowerCase();
      final custom = customByShortcode[shortcode];
      if (custom != null) {
        return CustomEmojiImage(
          shortcode: custom.shortcode,
          url: custom.url,
          size: _quickReactionGlyphSize,
        );
      }
    }
    return NativeEmojiGlyph(emoji: value, size: _quickReactionGlyphSize);
  }
}

/// Circular tap target shared by the quick-reaction emojis and the "+"
/// emoji-picker tile. Popovers keep the idle surface transparent while sheets
/// retain their filled treatment; both preserve the same hit and press areas.
class _QuickReactionCircle extends StatelessWidget {
  final VoidCallback onTap;
  final Widget child;
  final double size;
  final String semanticLabel;
  final bool showIdleBackground;

  const _QuickReactionCircle({
    required this.onTap,
    required this.child,
    required this.size,
    required this.semanticLabel,
    required this.showIdleBackground,
  });

  @override
  Widget build(BuildContext context) {
    final filledColor = Color.lerp(
      context.colors.surface,
      context.colors.primaryContainer,
      0.78,
    );
    return Semantics(
      button: true,
      label: semanticLabel,
      excludeSemantics: true,
      child: SizedBox.square(
        dimension: size,
        child: Material(
          color: showIdleBackground ? filledColor : Colors.transparent,
          shape: const CircleBorder(),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            customBorder: const CircleBorder(),
            highlightColor: context.colors.primary.withValues(alpha: 0.12),
            splashColor: context.colors.primary.withValues(alpha: 0.14),
            onTap: () {
              unawaited(HapticFeedback.lightImpact());
              onTap();
            },
            child: Center(child: child),
          ),
        ),
      ),
    );
  }
}

void _showEditSheet({
  required BuildContext context,
  required WidgetRef ref,
  required TimelineMessage message,
  required String channelId,
}) {
  final controller = TextEditingController(text: message.content);
  showBuzzModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (sheetContext) => Padding(
      padding: EdgeInsets.fromLTRB(
        Grid.gutter,
        0,
        Grid.gutter,
        MediaQuery.viewInsetsOf(sheetContext).bottom,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: controller,
            autofocus: true,
            minLines: 1,
            maxLines: 5,
            decoration: const InputDecoration(hintText: 'Edit message'),
          ),
          const SizedBox(height: Grid.xxs),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              TextButton(
                onPressed: () => Navigator.of(sheetContext).pop(),
                child: const Text('Cancel'),
              ),
              const SizedBox(width: Grid.half),
              FilledButton(
                onPressed: () {
                  final text = controller.text.trim();
                  if (text.isEmpty || text == message.content) {
                    Navigator.of(sheetContext).pop();
                    return;
                  }
                  ref
                      .read(channelActionsProvider)
                      .editMessage(
                        channelId: channelId,
                        eventId: message.id,
                        content: text,
                        mediaTags: buildCustomEmojiTags(
                          text,
                          ref.read(customEmojiListProvider),
                        ),
                      );
                  Navigator.of(sheetContext).pop();
                },
                child: const Text('Save'),
              ),
            ],
          ),
        ],
      ),
    ),
  );
}

void _confirmDelete({
  required BuildContext context,
  required WidgetRef ref,
  required String channelId,
  required String messageId,
  VoidCallback? onDeleted,
}) {
  showBuzzDialog<void>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: const Text('Delete message'),
      content: const Text('This cannot be undone.'),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(dialogContext).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () async {
            Navigator.of(dialogContext).pop();
            final messenger = ScaffoldMessenger.of(context);
            try {
              await ref
                  .read(channelActionsProvider)
                  .deleteMessage(channelId: channelId, eventId: messageId);
              onDeleted?.call();
            } catch (error) {
              messenger.showSnackBar(
                SnackBar(content: Text('Failed to delete message: $error')),
              );
            }
          },
          style: FilledButton.styleFrom(
            backgroundColor: dialogContext.colors.error,
          ),
          child: const Text('Delete'),
        ),
      ],
    ),
  );
}
