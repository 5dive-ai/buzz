import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchPersonaCatalogPublications,
  type PersonaCatalogPublication,
} from "@/features/agents/lib/personaCatalogRelay";
import { relayClient } from "@/shared/api/relayClient";
import { setPersonaShared } from "@/shared/api/tauriPersonas";
import type { AgentPersona } from "@/shared/api/types";
import { KIND_PERSONA } from "@/shared/constants/kinds";

export function personaCatalogQueryKey(communityId: string | null) {
  return ["persona-catalog", communityId] as const;
}

export function usePersonaCatalogQuery(communityId: string | null) {
  return useQuery<PersonaCatalogPublication[]>({
    enabled: communityId !== null,
    queryKey: personaCatalogQueryKey(communityId),
    queryFn: fetchPersonaCatalogPublications,
    staleTime: 30_000,
    refetchInterval: 120_000,
  });
}

export function usePersonaCatalogLiveUpdates(communityId: string | null): void {
  const queryClient = useQueryClient();

  React.useEffect(() => {
    if (!communityId) return;
    let disposed = false;
    let dispose: (() => Promise<void>) | null = null;

    void relayClient
      .subscribeLive({ kinds: [KIND_PERSONA], limit: 0 }, () => {
        void queryClient.invalidateQueries({
          queryKey: personaCatalogQueryKey(communityId),
        });
      })
      .then((unsubscribe) => {
        if (disposed) {
          void unsubscribe();
        } else {
          dispose = unsubscribe;
        }
      })
      .catch((error) => {
        console.error(
          "Couldn’t subscribe to the community agent catalog",
          error,
        );
      });

    const unsubscribeReconnect = relayClient.subscribeToReconnects(() => {
      void queryClient.invalidateQueries({
        queryKey: personaCatalogQueryKey(communityId),
      });
    });

    return () => {
      disposed = true;
      unsubscribeReconnect();
      if (dispose) void dispose();
    };
  }, [communityId, queryClient]);
}

export function useSetPersonaCatalogSharedMutation(communityId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, shared }: { id: string; shared: boolean }) =>
      setPersonaShared(id, shared),
    onSuccess: (updated) => {
      queryClient.setQueryData<AgentPersona[]>(
        ["personas"],
        (current) =>
          current?.map((persona) =>
            persona.id === updated.id ? updated : persona,
          ) ?? [updated],
      );
      void queryClient.invalidateQueries({
        queryKey: personaCatalogQueryKey(communityId),
      });
    },
  });
}
