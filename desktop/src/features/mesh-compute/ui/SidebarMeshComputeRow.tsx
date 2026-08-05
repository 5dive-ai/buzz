import { Share2 } from "lucide-react";

import { SidebarMenuButton, SidebarMenuItem } from "@/shared/ui/sidebar";
import { SidebarMenuLabel } from "@/shared/ui/sidebar-menu-label";
import { cn } from "@/shared/lib/cn";

import { useMeshComputeState } from "../hooks/useMeshComputeState";
import type { MeshRowPulse, MeshRowTone } from "../meshRowModel";
import { MeshComputePopover } from "./MeshComputePopover";

/**
 * The sidebar MeshLLM row.
 *
 * Replaces the ~120px footer card with one menu line beside Inbox and Agents,
 * because front-page sidebar space is premium. The row carries a single signal
 * — a coloured dot — and everything else lives in the popover it opens.
 *
 * The dot distinguishes six states, and the pair that matters most is `unknown`
 * vs `available`: "nobody is sharing" and "there is 115 GB here you have not
 * joined" must not look alike, since the second is the reason to look at all.
 * See `meshRowModel.ts`.
 */

const TONE_DOT: Record<MeshRowTone, string> = {
  // Hollow: nothing known. Deliberately not a filled grey, which would read as
  // a state rather than an absence of information.
  unknown: "border border-muted-foreground/45 bg-transparent",
  available: "bg-slate-400 dark:bg-slate-500",
  sharing: "bg-emerald-500 dark:bg-emerald-400",
  consuming: "bg-sky-500 dark:bg-sky-400",
  starting: "bg-amber-500 dark:bg-amber-400",
  failed: "bg-transparent border-2 border-destructive",
};

const TONE_PING: Record<MeshRowTone, string> = {
  unknown: "",
  // Slate rather than a tone colour: this is an invitation, not activity.
  available: "bg-slate-400 dark:bg-slate-500",
  sharing: "bg-emerald-500 dark:bg-emerald-400",
  consuming: "bg-sky-500 dark:bg-sky-400",
  starting: "bg-amber-500 dark:bg-amber-400",
  failed: "",
};

/**
 * Two facts want motion, so they must not look alike.
 *
 * `activity` is real work in flight — it uses Tailwind's stock ping, which is
 * quick and insistent, because something is happening right now.
 *
 * `invite` says there is compute here to tap into and this machine is outside
 * it. Nothing is happening, so it breathes slowly instead: noticeable on a
 * second glance, never competing with unread badges.
 */
const PULSE_CLASS: Record<MeshRowPulse, string> = {
  none: "",
  activity: "animate-ping",
  invite: "animate-mesh-invite",
};

export function SidebarMeshComputeRow({
  onOpenComputeSettings,
}: {
  onOpenComputeSettings?: () => void;
}) {
  const mesh = useMeshComputeState();
  const { row } = mesh;

  return (
    <SidebarMenuItem>
      <MeshComputePopover
        mesh={mesh}
        onOpenComputeSettings={onOpenComputeSettings}
      >
        <SidebarMenuButton
          className="data-[active=true]:font-normal"
          data-mesh-tone={row.tone}
          data-testid="sidebar-mesh-compute-row"
          tooltip={row.tooltip}
          type="button"
        >
          <span
            aria-hidden
            className="flex h-4 w-4 shrink-0 items-center justify-center"
          >
            {/*
              The dot is in every state, without exception. It is the row's
              reason to exist: hollow when nothing is known, slate when there is
              capacity to join, green while sharing, blue while consuming. An
              earlier revision swapped it for a Share2 glyph in the cold state,
              which threw away the signal and made the row read as a network
              widget rather than a status line.
            */}
            <span className="relative flex h-2 w-2 items-center justify-center">
              {row.pulse === "none" ? null : (
                <span
                  className={cn(
                    "absolute h-2 w-2 rounded-full opacity-75 motion-reduce:animate-none",
                    PULSE_CLASS[row.pulse],
                    TONE_PING[row.tone],
                  )}
                  data-mesh-pulse={row.pulse}
                />
              )}
              <span
                className={cn("h-2 w-2 rounded-full", TONE_DOT[row.tone])}
                data-testid="mesh-row-dot"
              />
            </span>
          </span>
          <SidebarMenuLabel className="opacity-80">
            {row.label}
          </SidebarMenuLabel>
        </SidebarMenuButton>
      </MeshComputePopover>

      {/*
        The trailing slot: an invitation when cold, capacity otherwise.

        Capacity shows in every state that has a number — not just while
        sharing.

        This slot used to hold a 70%-scaled unlabelled Switch, which was hard to
        see and ambiguous about what it would do. The control moved wholesale to
        the popover, which frees the slot for the figure. When this machine is
        outside the mesh the number *is* the invitation: "92 GB" argues for
        joining better than any exhortation, and unlike a nudge there is nothing
        to dismiss. Pointer-events off so the whole row stays one click target.
      */}
      {row.callToAction ? (
        <span
          className="pointer-events-none absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1 text-2xs font-medium text-muted-foreground group-data-[collapsible=icon]:hidden"
          data-testid="mesh-row-cta"
        >
          <Share2 aria-hidden className="h-3 w-3" />
          {row.callToAction}
        </span>
      ) : row.badge ? (
        <span
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-2xs tabular-nums text-muted-foreground group-data-[collapsible=icon]:hidden"
          data-testid="mesh-row-badge"
        >
          {row.badge}
        </span>
      ) : null}
    </SidebarMenuItem>
  );
}
