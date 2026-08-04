import type { useSidebarRelayConnectionCard } from "@/features/sidebar/ui/useSidebarRelayConnectionCard";
import { SidebarRelayConnectionCard } from "@/features/sidebar/ui/SidebarRelayConnectionCard";
import { SidebarUpdateCard } from "@/features/settings/SidebarUpdateCard";
import { SidebarMeshComputeCard } from "@/features/mesh-compute/ui/SidebarMeshComputeCard";

/**
 * The stack of transient cards above the sidebar profile row.
 *
 * Extracted from `AppSidebar.tsx` because that file sits exactly at the
 * 1000-line ceiling enforced by `desktop/scripts/check-file-sizes.mjs` — there
 * was no room to add another card inline, and this is a self-contained concern.
 *
 * Ordering is a priority queue, most urgent first: a broken relay connection
 * outranks an available update, which outranks the shared-compute card. Each
 * card is individually responsible for rendering nothing when it has nothing to
 * say, so the footer does not become permanent clutter.
 */
export function SidebarFooterNotices({
  expanded,
  onDismissRelayConnectionCard,
  onDismissUpdateCard,
  onOpenComputeSettings,
  onReconnectRelay,
  relayConnectionCard,
  showUpdateCard,
}: {
  /** Whether the sidebar is expanded (icon-collapse hides these cards). */
  expanded: boolean;
  onDismissRelayConnectionCard: () => void;
  onDismissUpdateCard: () => void;
  onOpenComputeSettings: () => void;
  onReconnectRelay: () => void;
  relayConnectionCard: ReturnType<typeof useSidebarRelayConnectionCard>;
  showUpdateCard: boolean;
}) {
  return (
    <>
      {relayConnectionCard.showSidebarRelayConnectionCard && expanded ? (
        <SidebarRelayConnectionCard
          className="mb-2"
          isConnected={relayConnectionCard.isRelayConnectionSuccess}
          isReconnectPending={relayConnectionCard.isRelayReconnectPending}
          isWaitingOnReconnectHook={
            relayConnectionCard.isWaitingOnReconnectHook
          }
          onDismiss={onDismissRelayConnectionCard}
          onReconnect={onReconnectRelay}
        />
      ) : null}
      {showUpdateCard ? (
        <div className="mb-2 group-data-[collapsible=icon]:hidden">
          <SidebarUpdateCard onDismiss={onDismissUpdateCard} />
        </div>
      ) : null}
      {/*
        Yield to the cards above: a relay problem or a pending update is more
        urgent than an invitation to share compute.
      */}
      {relayConnectionCard.showSidebarRelayConnectionCard ||
      showUpdateCard ? null : (
        <SidebarMeshComputeCard
          className="mb-2"
          onOpenComputeSettings={onOpenComputeSettings}
        />
      )}
    </>
  );
}
