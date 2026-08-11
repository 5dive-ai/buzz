import { ExternalLink } from "lucide-react";

import type { Project, Repository } from "@/features/projects/hooks";
import { Button } from "@/shared/ui/button";
import { ProjectRepositoryManagement } from "./ProjectRepositoryManagement";

/**
 * Repository-scoped controls for the project detail chrome: the repository
 * picker (with access management) plus, when the repository has a browsable
 * web page, an external-link button. Extracted from `ProjectDetailScreen` to
 * keep the screen under the file-size ratchet.
 */
export function ProjectDetailChromeActions({
  identityPubkey,
  onRepositoryChange,
  project,
  projects,
  repository,
  webUrl,
}: {
  identityPubkey?: string;
  onRepositoryChange: (repositoryId: string) => void;
  project: Project;
  projects: Project[];
  repository: Repository;
  /** Browsable repository web page, already gated by the caller. */
  webUrl: string | null;
}) {
  return (
    <>
      <ProjectRepositoryManagement
        identityPubkey={identityPubkey}
        onChange={onRepositoryChange}
        project={project}
        projects={projects}
        repository={repository}
      />
      {webUrl ? (
        <Button
          asChild
          aria-label="Open project web page"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          size="icon"
          variant="ghost"
        >
          <a href={webUrl} rel="noopener noreferrer" target="_blank">
            <ExternalLink className="h-4 w-4" />
          </a>
        </Button>
      ) : null}
    </>
  );
}
