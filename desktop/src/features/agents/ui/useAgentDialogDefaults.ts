import * as React from "react";

import { useBakedBuildEnvQuery } from "../hooks";
import { useGlobalAgentConfig } from "../useGlobalAgentConfig";
import { getInheritedAgentDefaults } from "./bakedEnvHelpers";

export function useAgentDialogDefaults({
  inheritedEnvVars = {},
  open,
  nativeEffortKey,
  acceptedEffortValues,
}: {
  inheritedEnvVars?: Record<string, string>;
  open: boolean;
  /**
   * The native effort key for the current runtime
   * (e.g. `runtime.thinkingEnvVar`). When absent, falls back to the
   * buzz-agent legacy key — preserving existing behavior for callers that
   * haven't yet passed runtime metadata.
   */
  nativeEffortKey?: string | null;
  /**
   * Canonical effort values for normalization (from `runtime.acceptedEffortValues`).
   * Passed through to `getInheritedAgentDefaults` so global native effort is
   * normalized (e.g. xhigh→max) before display. Null for buzz-agent.
   */
  acceptedEffortValues?: readonly string[] | null;
}) {
  const { globalConfig } = useGlobalAgentConfig();
  const { data: bakedEnv } = useBakedBuildEnvQuery({ enabled: open });
  const inheritedDefaults = getInheritedAgentDefaults(
    globalConfig,
    bakedEnv,
    nativeEffortKey
      ? { nativeEffortKey, acceptedEffortValues: acceptedEffortValues ?? null }
      : undefined,
  );
  const resolvedEffortKey = nativeEffortKey ?? "BUZZ_AGENT_THINKING_EFFORT";
  const effectiveInheritedEnvVars = React.useMemo(
    () => ({
      ...globalConfig.env_vars,
      ...inheritedEnvVars,
      ...(inheritedDefaults.effort.value
        ? { [resolvedEffortKey]: inheritedDefaults.effort.value }
        : {}),
    }),
    [
      globalConfig.env_vars,
      inheritedDefaults.effort.value,
      inheritedEnvVars,
      resolvedEffortKey,
    ],
  );
  return {
    globalConfig,
    inheritedDefaults,
    inheritedEnvVars: effectiveInheritedEnvVars,
  };
}
