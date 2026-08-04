import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

type PassportRouteSearch = {
  /** Passport holder. Omitted = the current user's own passport. */
  pubkey?: string;
};

function validatePassportSearch(
  search: Record<string, unknown>,
): PassportRouteSearch {
  return {
    pubkey:
      typeof search.pubkey === "string" && search.pubkey.length > 0
        ? search.pubkey
        : undefined,
  };
}

const PassportScreen = React.lazy(async () => {
  const module = await import("@/features/passport/ui/PassportScreen");
  return { default: module.PassportScreen };
});

export const Route = createFileRoute("/passport")({
  validateSearch: validatePassportSearch,
  component: PassportRouteComponent,
});

function PassportRouteComponent() {
  const { pubkey } = Route.useSearch();

  return (
    <React.Suspense fallback={<ViewLoadingFallback kind="workflows" />}>
      <PassportScreen pubkey={pubkey} />
    </React.Suspense>
  );
}
