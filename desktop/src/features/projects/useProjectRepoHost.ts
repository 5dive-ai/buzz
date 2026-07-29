import type { Project } from "@/features/projects/hooks";
import {
  type ProjectRepoHost,
  projectRepoHostForProject,
} from "@/features/projects/lib/projectRepoHost";
import { isSafeUrl } from "@/shared/lib/url";
import { useRelayOrigin } from "@/shared/lib/useRelayOrigin";

export function useProjectRepoHost(
  project: Project | null | undefined,
): ProjectRepoHost {
  return projectRepoHostForProject(project, useRelayOrigin());
}

export function useProjectRepoPresentation(
  project: Project | null | undefined,
) {
  const host = useProjectRepoHost(project);
  const webUrl =
    project?.webUrl && isSafeUrl(project.webUrl) ? project.webUrl : null;

  return {
    host,
    webUrl,
    canCloneLocally:
      host.kind === "buzz" ||
      (host.kind === "external" && host.host === "github.com"),
    controls: {
      externalUrl: host.kind === "external" ? webUrl : null,
      remoteKind: host.kind === "unresolved" ? undefined : host.kind,
      remoteLabel:
        host.kind === "external"
          ? host.host
          : host.kind === "buzz"
            ? "Buzz"
            : "Remote",
    },
  };
}
