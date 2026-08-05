import { SidebarMenuButton, SidebarMenuItem } from "@/shared/ui/sidebar";
import { SidebarMenuLabel } from "@/shared/ui/sidebar-menu-label";
import { Switch } from "@/shared/ui/switch";
import { cn } from "@/shared/lib/cn";

import { useMeshComputeState } from "../hooks/useMeshComputeState";
import type { MeshRowTone } from "../meshRowModel";
import { MeshComputePopover } from "./MeshComputePopover";

/**
 * The sidebar Community mesh row.
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
  available: "",
  sharing: "bg-emerald-500 dark:bg-emerald-400",
  consuming: "bg-sky-500 dark:bg-sky-400",
  starting: "bg-amber-500 dark:bg-amber-400",
  failed: "",
};

export function SidebarMeshComputeRow({
  onOpenComputeSettings,
}: {
  onOpenComputeSettings?: () => void;
}) {
  const mesh = useMeshComputeState();
  const { row, setSharing } = mesh;

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
            <span className="relative flex h-2 w-2 items-center justify-center">
              {row.pulse ? (
                <span
                  className={cn(
                    "absolute h-2 w-2 animate-ping rounded-full opacity-75 motion-reduce:animate-none",
                    TONE_PING[row.tone],
                  )}
                />
              ) : null}
              <span
                className={cn("h-2 w-2 rounded-full", TONE_DOT[row.tone])}
                data-testid="mesh-row-dot"
              />
            </span>
          </span>
          <SidebarMenuLabel className="opacity-80">
            Community mesh
          </SidebarMenuLabel>
        </SidebarMenuButton>
      </MeshComputePopover>

      {/*
        The switch sits outside the button rather than inside it: nesting a
        control in a control is invalid, and the row itself must stay clickable
        as the way into the popover.

        Hidden once sharing — the state is legible from the dot, and Stop lives
        in the popover. Collapsed sidebars hide it too: no room, and the dot
        plus tooltip still carry the state.
      */}
      {row.showSwitch ? (
        <div className="absolute right-2 top-1/2 -translate-y-1/2 group-data-[collapsible=icon]:hidden">
          <Switch
            aria-label={row.switchLabel}
            checked={false}
            className="scale-[0.7]"
            data-testid="mesh-row-share-toggle"
            onCheckedChange={setSharing}
          />
        </div>
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
