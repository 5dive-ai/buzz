import { DeleteDataAction } from "./DeleteDataAction";

/** Settings card for the destructive local-data deletion flow. */
export function SignOutSection() {
  return (
    <div
      className="mt-8 border-t border-border/60 pb-6 pt-5"
      data-testid="settings-signout"
    >
      <div className="flex items-center justify-between gap-4 px-1">
        <div className="min-w-0 space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">Sign out</h2>
          <p className="text-sm text-muted-foreground">
            Removes your identity key and all local app data from this device.
            Before signing out, create and test a password-protected key backup
            above — this cannot be undone.
          </p>
        </div>
        <DeleteDataAction className="shrink-0" />
      </div>
    </div>
  );
}
