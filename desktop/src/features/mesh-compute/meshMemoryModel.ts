import type { MeshLiveView, MeshModelCatalog } from "@/shared/api/tauriMesh";

export const MEMORY_SEGMENTS = 10;

export type MeshMemoryModel = {
  totalGb: number | null;
  usedGb: number | null;
  usedSegments: number;
  totalSegments: number;
  label: string;
};

/**
 * Approximate model footprint against this machine's shareable AI memory.
 * MeshLLM reports model package size, not live OS GPU allocation, so the UI
 * deliberately says "model uses" rather than claiming real-time utilization.
 */
export function deriveMeshMemoryModel({
  view,
  catalog,
  modelRef,
}: {
  view: MeshLiveView | null;
  catalog: MeshModelCatalog | null;
  modelRef: string | null;
}): MeshMemoryModel {
  const totalGb = view?.selfCapacityGb ?? catalog?.vramGb ?? null;
  const catalogSize = catalog?.entries.find(
    (entry) => entry.name === modelRef,
  )?.sizeGb;
  const reportedSize = view?.selfModelSizeGb;
  const usedGb =
    reportedSize != null && reportedSize > 0
      ? reportedSize
      : catalogSize != null && catalogSize > 0
        ? catalogSize
        : null;
  const ratio =
    totalGb != null && totalGb > 0 && usedGb != null
      ? Math.min(1, usedGb / totalGb)
      : 0;
  const usedSegments =
    ratio > 0 ? Math.max(1, Math.ceil(ratio * MEMORY_SEGMENTS)) : 0;

  return {
    totalGb,
    usedGb,
    usedSegments,
    totalSegments: MEMORY_SEGMENTS,
    label:
      usedGb != null && totalGb != null
        ? `${formatGb(usedGb)} of ${formatGb(totalGb)} AI memory used by model`
        : totalGb != null
          ? `${formatGb(totalGb)} AI memory available`
          : "Checking available AI memory…",
  };
}

function formatGb(gb: number): string {
  const rounded = gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10;
  return `${rounded} GB`;
}
