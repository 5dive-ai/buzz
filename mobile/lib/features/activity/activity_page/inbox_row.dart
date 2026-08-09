part of '../activity_page.dart';

const _inboxSwipeActionInset = Grid.half;
const _inboxSwipeActionLabelMinWidth = Grid.xxl;
const _inboxSwipeLabelRevealWidth =
    _inboxSwipeActionLabelMinWidth + (_inboxSwipeActionInset * 2);

/// "New" boundary between unread and previously read rows.
class _NewBoundaryDivider extends StatelessWidget {
  const _NewBoundaryDivider();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: Grid.gutter,
        vertical: Grid.half,
      ),
      child: Row(
        children: [
          Expanded(
            child: Divider(color: context.colors.error.withValues(alpha: 0.5)),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: Grid.xxs),
            child: Text(
              'New',
              style: context.textTheme.labelSmall?.copyWith(
                color: context.colors.error,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          Expanded(
            child: Divider(color: context.colors.error.withValues(alpha: 0.5)),
          ),
        ],
      ),
    );
  }
}

/// One conversation row, matching desktop's inbox item hierarchy:
/// avatar | sender + unread dot + time | contextual label | preview.
///
/// Swiping left reveals the row's read-state action. Opening remains a tap or
/// long-press action, so the swipe has one clear, easily recoverable outcome.
class _InboxRow extends HookConsumerWidget {
  final InboxItem item;
  final Channel? channel;
  final String? currentPubkey;
  final bool isDone;
  final VoidCallback onTap;
  final VoidCallback onMarkRead;
  final VoidCallback onMarkUnread;

  const _InboxRow({
    super.key,
    required this.item,
    required this.channel,
    required this.currentPubkey,
    required this.isDone,
    required this.onTap,
    required this.onMarkRead,
    required this.onMarkUnread,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    const restingRevealWidth = 132.0;
    const commitThreshold = 0.58;
    final actionSnapshotKey = useMemoized(GlobalKey.new, const []);
    final actionSnapshotPixelRatio = MediaQuery.devicePixelRatioOf(context);
    final actionPopoverPresented = useState(false);
    final revealAmount = useState(0.0);
    final isDragging = useState(false);
    final labelHapticFired = useRef(false);
    final userCache = ref.watch(userCacheProvider);
    final profile = userCache[item.item.pubkey.toLowerCase()];
    final senderLabel = profile?.displayName ?? shortPubkey(item.item.pubkey);
    final profileMentionNames = {
      for (final pubkey in mentionedPubkeysFromTags(item.item.tags))
        if (userCache[pubkey]?.displayName?.trim().isNotEmpty == true)
          pubkey: userCache[pubkey]!.displayName!.trim(),
    };
    final mentionPubkeys = mentionedPubkeysFromTags(item.item.tags);
    final knownAgentPubkeys = channel == null
        ? ref.watch(knownAgentPubkeysProvider)
        : ref.watch(agentMentionPubkeysProvider(channel!.id));
    final agentMentionPubkeys = agentPubkeysWithProfileOwners(
      knownAgentPubkeys: knownAgentPubkeys,
      profileOwnedAgentPubkeys: [
        for (final profile in userCache.values)
          if (profile.ownerPubkey != null) profile.pubkey,
      ],
    );
    final mentionNames = mentionNamesWithDirectoryLabels(
      mentionPubkeys: mentionPubkeys,
      profileMentionNames: profileMentionNames,
      directoryDisplayNames: ref.watch(agentDirectoryDisplayNamesProvider),
      agentMentionPubkeys: agentMentionPubkeys,
    );

    final isDm = channel?.isDm ?? false;
    final channelName = channel != null && !isDm
        ? (channel!.name.isNotEmpty ? channel!.name : null)
        : null;
    final label = inboxTypeLabel(
      item,
      channelName: channelName,
      isDm: isDm,
      senderLabel: senderLabel,
    );

    final mutedColor = context.colors.onSurfaceVariant;
    final labelColor = item.isActionRequired && !isDone
        ? context.colors.tertiary
        : mutedColor;

    final reducedMotion = MediaQuery.of(context).disableAnimations;
    final swipeDirection = Directionality.of(context) == TextDirection.ltr
        ? 1.0
        : -1.0;
    void closeActions() => revealAmount.value = 0;
    void toggleReadState() {
      closeActions();
      isDone ? onMarkUnread() : onMarkRead();
    }

    Future<ui.Image> captureActionSnapshot() async {
      await WidgetsBinding.instance.endOfFrame;
      final renderObject = actionSnapshotKey.currentContext?.findRenderObject();
      if (renderObject is! RenderRepaintBoundary) {
        throw StateError('Activity row snapshot is unavailable');
      }
      return renderObject.toImage(pixelRatio: actionSnapshotPixelRatio);
    }

    Rect? actionSnapshotRect() {
      final renderObject = actionSnapshotKey.currentContext?.findRenderObject();
      if (renderObject is! RenderRepaintBoundary || !renderObject.hasSize) {
        return null;
      }
      return renderObject.localToGlobal(Offset.zero) & renderObject.size;
    }

    Future<void> openRowActions() async {
      if (isDragging.value) return;
      final anchorRect = actionSnapshotRect();
      if (anchorRect == null) {
        _showRowActionsSheet(context);
        return;
      }
      final presented = await _showActivityRowActionsPopover(
        context: context,
        anchorRect: anchorRect,
        captureAnchorSnapshot: captureActionSnapshot,
        actions: [
          _ActivityRowAction(
            id: isDone ? 'markUnread' : 'markRead',
            title: isDone ? 'Mark unread' : 'Mark as read',
            symbol: isDone ? 'envelope.badge' : 'envelope.open',
            icon: isDone ? LucideIcons.mailOpen : LucideIcons.mailCheck,
            onSelected: isDone ? onMarkUnread : onMarkRead,
          ),
          _ActivityRowAction(
            id: 'openConversation',
            title: 'Open conversation',
            symbol: 'arrow.up.right.square',
            icon: LucideIcons.externalLink,
            onSelected: onTap,
          ),
        ],
        onPopoverPresented: () => actionPopoverPresented.value = true,
        onPopoverDismissed: () => actionPopoverPresented.value = false,
      );
      if (!presented && context.mounted) _showRowActionsSheet(context);
    }

    return LayoutBuilder(
      builder: (context, constraints) {
        final actionExtent = constraints.maxWidth;
        final revealedWidth = revealAmount.value
            .clamp(0, actionExtent)
            .toDouble();
        final actionColor = isDone
            ? context.colors.primary
            : context.appColors.success;
        return ClipRect(
          child: Stack(
            children: [
              if (revealedWidth > 0)
                PositionedDirectional(
                  top: 0,
                  end: 0,
                  bottom: 0,
                  width: revealedWidth,
                  child: Padding(
                    key: ValueKey('inbox-swipe-background-${item.id}'),
                    padding: const EdgeInsets.all(_inboxSwipeActionInset),
                    child: _InboxSwipeAction(
                      key: ValueKey('inbox-swipe-read-${item.id}'),
                      color: actionColor,
                      foregroundColor: contrastForeground(actionColor),
                      icon: isDone ? LucideIcons.mail : LucideIcons.mailOpen,
                      label: isDone ? 'Mark unread' : 'Mark as read',
                      onTap: toggleReadState,
                    ),
                  ),
                ),
              AnimatedSlide(
                offset: Offset(
                  -swipeDirection * revealAmount.value / constraints.maxWidth,
                  0,
                ),
                duration: reducedMotion || isDragging.value
                    ? Duration.zero
                    : const Duration(milliseconds: 160),
                curve: Curves.easeOutCubic,
                child: Opacity(
                  key: ValueKey('activity-row-action-source-${item.id}'),
                  opacity: actionPopoverPresented.value ? 0 : 1,
                  child: GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onHorizontalDragStart: (_) {
                      isDragging.value = true;
                      labelHapticFired.value = false;
                    },
                    onHorizontalDragUpdate: (details) {
                      isDragging.value = true;
                      final previous = revealAmount.value;
                      final next =
                          (previous - (details.delta.dx * swipeDirection))
                              .clamp(0, actionExtent)
                              .toDouble();
                      if (!labelHapticFired.value &&
                          previous < _inboxSwipeLabelRevealWidth &&
                          next >= _inboxSwipeLabelRevealWidth) {
                        labelHapticFired.value = true;
                        unawaited(HapticFeedback.selectionClick());
                      }
                      revealAmount.value = next;
                    },
                    onHorizontalDragEnd: (details) {
                      isDragging.value = false;
                      final velocity = details.primaryVelocity ?? 0;
                      final shouldCommit =
                          (velocity * swipeDirection) < -900 ||
                          revealAmount.value >= actionExtent * commitThreshold;
                      if (shouldCommit) {
                        toggleReadState();
                      } else {
                        revealAmount.value =
                            (velocity * swipeDirection) < -200 ||
                                revealAmount.value >= restingRevealWidth / 2
                            ? restingRevealWidth
                            : 0;
                      }
                    },
                    child: RepaintBoundary(
                      key: actionSnapshotKey,
                      child: Material(
                        color: context.colors.surface,
                        child: _ActivityLongPressInkWell(
                          key: ValueKey('inbox-row-${item.id}'),
                          onTap: onTap,
                          onLongPress: () => unawaited(openRowActions()),
                          child: Padding(
                            padding: const EdgeInsets.symmetric(
                              horizontal: Grid.gutter,
                              vertical: Grid.twelve,
                            ),
                            child: Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                _RowAvatar(
                                  pubkey: item.item.pubkey,
                                  profile: profile,
                                ),
                                const SizedBox(width: messageAvatarContentGap),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      // Sender + unread dot + timestamp.
                                      Row(
                                        children: [
                                          Expanded(
                                            child: MessageAuthorMeta(
                                              displayName: senderLabel,
                                              username: messageUsernameLabel(
                                                profile,
                                              ),
                                              timestamp: _inboxTimestamp(
                                                item.latestActivityAt,
                                              ),
                                              nameColor:
                                                  context.colors.onSurface,
                                              metadataColor: mutedColor,
                                              nameStyle:
                                                  activityUsernameTextStyle,
                                              metadataStyle:
                                                  activityTimestampTextStyle,
                                              displayNameKey: ValueKey(
                                                'activity-author-${item.id}',
                                              ),
                                              usernameKey: ValueKey(
                                                'activity-username-${item.id}',
                                              ),
                                              timestampKey: ValueKey(
                                                'activity-timestamp-${item.id}',
                                              ),
                                            ),
                                          ),
                                          if (!isDone) ...[
                                            const SizedBox(width: Grid.xxs),
                                            Container(
                                              key: ValueKey(
                                                'inbox-unread-dot-${item.id}',
                                              ),
                                              width: 6,
                                              height: 6,
                                              decoration: BoxDecoration(
                                                shape: BoxShape.circle,
                                                color: context.colors.primary,
                                              ),
                                            ),
                                          ],
                                        ],
                                      ),
                                      const SizedBox(height: Grid.quarter),
                                      // Contextual label: "Mentioned in #channel" etc.
                                      Row(
                                        children: [
                                          Flexible(
                                            child: Text(
                                              label.text,
                                              style: activityContextTextStyle
                                                  .copyWith(color: labelColor),
                                              overflow: TextOverflow.ellipsis,
                                            ),
                                          ),
                                          if (label.channelLabel != null) ...[
                                            const SizedBox(width: Grid.half),
                                            Flexible(
                                              child: Container(
                                                padding:
                                                    const EdgeInsets.symmetric(
                                                      horizontal:
                                                          Grid.half +
                                                          Grid.quarter,
                                                      vertical:
                                                          Grid.quarter / 2,
                                                    ),
                                                decoration: BoxDecoration(
                                                  color: context
                                                      .colors
                                                      .surfaceContainerHighest,
                                                  borderRadius:
                                                      BorderRadius.circular(
                                                        Grid.half,
                                                      ),
                                                ),
                                                child: Text(
                                                  '#${label.channelLabel}',
                                                  style:
                                                      activityContextTextStyle
                                                          .copyWith(
                                                            color: mutedColor,
                                                          ),
                                                  overflow:
                                                      TextOverflow.ellipsis,
                                                ),
                                              ),
                                            ),
                                          ],
                                        ],
                                      ),
                                      const SizedBox(height: Grid.half),
                                      // Message preview.
                                      MessageContent(
                                        content: item.item.displayContent,
                                        mentionNames: mentionNames,
                                        agentMentionPubkeys:
                                            agentMentionPubkeys,
                                        tags: item.item.tags,
                                        maxLines: 2,
                                        baseStyle: activityPreviewTextStyle
                                            .copyWith(
                                              color: context.colors.onSurface,
                                            ),
                                      ),
                                    ],
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  void _showRowActionsSheet(BuildContext context) {
    showBuzzModalBottomSheet<void>(
      context: context,
      builder: (sheetContext) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            Grid.gutter,
            0,
            Grid.gutter,
            Grid.xs,
          ),
          child: IconTheme.merge(
            data: const IconThemeData(size: 18),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                ListTile(
                  leading: Icon(
                    isDone ? LucideIcons.mail : LucideIcons.mailOpen,
                  ),
                  title: Text(isDone ? 'Mark unread' : 'Mark as read'),
                  onTap: () {
                    Navigator.of(sheetContext).pop();
                    isDone ? onMarkUnread() : onMarkRead();
                  },
                ),
                ListTile(
                  leading: const Icon(LucideIcons.externalLink),
                  title: const Text('Open conversation'),
                  onTap: () {
                    Navigator.of(sheetContext).pop();
                    onTap();
                  },
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ActivityLongPressInkWell extends StatelessWidget {
  final VoidCallback onTap;
  final VoidCallback onLongPress;
  final Widget child;

  const _ActivityLongPressInkWell({
    super.key,
    required this.onTap,
    required this.onLongPress,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    return Semantics(
      onLongPress: onLongPress,
      child: GestureDetector(
        behavior: HitTestBehavior.translucent,
        onLongPressStart: (_) => onLongPress(),
        child: InkWell(onTap: onTap, child: child),
      ),
    );
  }
}

class _InboxSwipeAction extends StatelessWidget {
  final Color color;
  final Color foregroundColor;
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  const _InboxSwipeAction({
    super.key,
    required this.color,
    required this.foregroundColor,
    required this.icon,
    required this.label,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) => Material(
    color: color,
    borderRadius: BorderRadius.circular(Radii.full),
    clipBehavior: Clip.antiAlias,
    child: InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(Radii.full),
      child: Semantics(
        button: true,
        label: label,
        child: LayoutBuilder(
          builder: (context, constraints) {
            if (constraints.maxWidth < Grid.lg) {
              return const SizedBox.shrink();
            }
            final showLabel =
                constraints.maxWidth >= _inboxSwipeActionLabelMinWidth;
            return Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(icon, size: 18, color: foregroundColor),
                if (showLabel) ...[
                  const SizedBox(height: Grid.quarter),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: Grid.xxs),
                    child: Text(
                      label,
                      maxLines: 2,
                      softWrap: true,
                      textAlign: TextAlign.center,
                      style: context.textTheme.labelSmall?.copyWith(
                        color: foregroundColor,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ],
              ],
            );
          },
        ),
      ),
    ),
  );
}

class _RowAvatar extends StatelessWidget {
  final String pubkey;
  final UserProfile? profile;

  const _RowAvatar({required this.pubkey, required this.profile});

  @override
  Widget build(BuildContext context) {
    final initial =
        profile?.initial ?? (pubkey.isNotEmpty ? pubkey[0].toUpperCase() : '?');
    return AvatarImage(
      imageUrl: profile?.avatarUrl,
      radius: activityAvatarSize / 2,
      backgroundColor: context.colors.primaryContainer,
      fallback: Text(
        initial,
        style: TextStyle(
          fontSize: 14,
          fontWeight: FontWeight.w600,
          color: context.colors.onPrimaryContainer,
        ),
      ),
    );
  }
}
