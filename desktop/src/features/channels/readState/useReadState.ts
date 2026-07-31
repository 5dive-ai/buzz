import * as React from "react";
import {
  ReadStateManager,
  type ContextParentResolver,
  type MarkResult,
} from "@/features/channels/readState/readStateManager";
import type { OverrideLiveness } from "@/features/channels/readState/readStateFormat";
import type { RelayClient } from "@/shared/api/relayClientSession";

const noopGetTimestamp = () => null;
const noopMarkRead = () => {};
const noopDrainAdvances = (): ReadonlySet<string> => new Set<string>();
const noopSetResolver = () => {};
const noopMarkOverride = (): MarkResult => ({
  success: false,
  reason: "load_incomplete",
});
const noopGetOverrideLiveness = (): OverrideLiveness | null => null;

/**
 * React hook that creates and manages a ReadStateManager instance.
 * Returns no-op functions when pubkey or relayClient are not available.
 */
export function useReadState(
  pubkey: string | undefined,
  relayClient: RelayClient | undefined,
) {
  const [readStateVersion, forceUpdate] = React.useReducer(
    (x: number) => x + 1,
    0,
  );
  const [initializedPubkey, setInitializedPubkey] = React.useState<
    string | null
  >(null);
  const managerRef = React.useRef<ReadStateManager | null>(null);

  // Create/destroy manager when pubkey becomes available/changes
  React.useEffect(() => {
    setInitializedPubkey(null);
    if (!pubkey || !relayClient) return;

    let isCancelled = false;
    const manager = new ReadStateManager(pubkey, relayClient);
    managerRef.current = manager;

    const unsubscribe = manager.subscribe(() => {
      forceUpdate();
    });

    void manager.initialize().finally(() => {
      if (!isCancelled) {
        setInitializedPubkey(pubkey);
      }
    });

    return () => {
      isCancelled = true;
      unsubscribe();
      manager.destroy();
      managerRef.current = null;
    };
  }, [pubkey, relayClient]);

  const getEffectiveTimestamp = React.useCallback(
    (contextId: string): number | null => {
      return managerRef.current?.getEffectiveTimestamp(contextId) ?? null;
    },
    [],
  );

  const getOwnTimestamp = React.useCallback(
    (contextId: string): number | null => {
      return managerRef.current?.getOwnTimestamp(contextId) ?? null;
    },
    [],
  );

  const markContextRead = React.useCallback(
    (contextId: string, unixTimestamp: number): void => {
      managerRef.current?.markContextRead(contextId, unixTimestamp);
    },
    [],
  );

  const seedContextRead = React.useCallback(
    (contextId: string, unixTimestamp: number): void => {
      managerRef.current?.seedContextRead(contextId, unixTimestamp);
    },
    [],
  );

  const drainSyncedAdvances = React.useCallback((): ReadonlySet<string> => {
    return managerRef.current?.drainSyncedAdvances() ?? new Set<string>();
  }, []);

  const setContextParentResolver = React.useCallback(
    (resolver: ContextParentResolver | null): void => {
      managerRef.current?.setContextParentResolver(resolver);
    },
    [],
  );

  // Override APIs for the NIP-RS manual-unread layer (slice 3 seam).
  const markChannelUnread = React.useCallback(
    (channelId: string): MarkResult => {
      return (
        managerRef.current?.markChannelUnread(channelId) ?? {
          success: false,
          reason: "load_incomplete",
        }
      );
    },
    [],
  );

  const markChannelRead = React.useCallback((channelId: string): MarkResult => {
    return (
      managerRef.current?.markChannelRead(channelId) ?? {
        success: false,
        reason: "load_incomplete",
      }
    );
  }, []);

  const getOverrideLiveness = React.useCallback(
    (channelId: string): OverrideLiveness | null => {
      return managerRef.current?.getOverrideLiveness(channelId) ?? null;
    },
    [],
  );

  const isReady = Boolean(
    pubkey && relayClient && initializedPubkey === pubkey,
  );

  if (!pubkey || !relayClient) {
    return {
      getEffectiveTimestamp: noopGetTimestamp,
      isReady: false,
      markContextRead: noopMarkRead,
      seedContextRead: noopMarkRead,
      drainSyncedAdvances: noopDrainAdvances,
      setContextParentResolver: noopSetResolver,
      readStateVersion: 0,
      getOwnTimestamp: noopGetTimestamp,
      markChannelUnread: noopMarkOverride,
      markChannelRead: noopMarkOverride,
      getOverrideLiveness: noopGetOverrideLiveness,
    };
  }

  return {
    getEffectiveTimestamp,
    isReady,
    markContextRead,
    seedContextRead,
    drainSyncedAdvances,
    setContextParentResolver,
    readStateVersion,
    getOwnTimestamp,
    markChannelUnread,
    markChannelRead,
    getOverrideLiveness,
  };
}
