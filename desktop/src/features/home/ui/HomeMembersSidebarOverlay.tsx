import * as React from "react";

import type { Channel } from "@/shared/api/types";

const MembersSidebar = React.lazy(async () => {
  const module = await import("@/features/channels/ui/MembersSidebar");
  return { default: module.MembersSidebar };
});

export function HomeMembersSidebarOverlay({
  channel,
  currentPubkey,
  onClose,
}: {
  channel: Channel | null;
  currentPubkey?: string;
  onClose: () => void;
}) {
  if (!channel) return null;

  return (
    <React.Suspense fallback={null}>
      <MembersSidebar
        channel={channel}
        currentPubkey={currentPubkey}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) onClose();
        }}
        open={true}
      />
    </React.Suspense>
  );
}
