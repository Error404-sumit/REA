import type { ArtifactOccurrence } from "../../domain/artifactGraph.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";

/** The active reader's complete inventory, distinct from the requested output. */
export interface ArtifactExtractionSelection {
  readonly available: readonly ArtifactOccurrence[];
  readonly selected: readonly ArtifactOccurrence[];
}

/**
 * Determine reader ownership before applying the caller's filter. Otherwise
 * excluding an archive could incorrectly promote its nested members into the
 * outer reader. Preserve inventory order so request order cannot change output.
 */
export const selectArtifactExtractionOccurrences = (
  occurrences: readonly ArtifactOccurrence[],
  requestedIds?: readonly string[],
): ArtifactExtractionSelection => {
  const regular = occurrences.filter(
    (occurrence) =>
      (occurrence.entry_kind === "file" || occurrence.entry_kind === "slice") &&
      occurrence.logical_path !== ".",
  );
  const regularPaths = new Set(regular.map(({ logical_path }) => logical_path));
  const available = regular.filter(({ logical_path }) => {
    let path = logical_path;
    for (
      let slash = path.lastIndexOf("/");
      slash >= 0;
      slash = path.lastIndexOf("/")
    ) {
      path = path.slice(0, slash);
      if (regularPaths.has(path)) return false;
    }
    return true;
  });
  if (requestedIds === undefined) return { available, selected: available };
  if (requestedIds.length === 0)
    throw invalidSelection(
      "An explicit occurrence_ids selection must not be empty.",
    );
  const requested = new Set(requestedIds);
  if (requested.size !== requestedIds.length)
    throw invalidSelection("Occurrence IDs must be unique.");
  const activeIds = new Set(
    available.map(({ occurrence_id }) => occurrence_id),
  );
  const byId = new Map(
    occurrences.map((occurrence) => [occurrence.occurrence_id, occurrence]),
  );
  for (const id of requested) {
    const occurrence = byId.get(id);
    if (occurrence === undefined)
      throw invalidSelection(
        `Occurrence is not in the current artifact inventory: ${id}. Inspect the active artifact again before selecting entries.`,
      );
    if (!activeIds.has(id))
      throw invalidSelection(
        `Occurrence is not a regular file or slice exposed by the active reader: ${occurrence.logical_path} (${id}). Open a containing archive separately to extract its nested members.`,
      );
  }
  return {
    available,
    selected: available.filter(({ occurrence_id }) =>
      requested.has(occurrence_id),
    ),
  };
};

const invalidSelection = (message: string): AnalysisInputError =>
  new AnalysisInputError("extract_artifact", undefined, [
    {
      path: ["occurrence_ids"],
      reason: "invalid_value",
      message,
    },
  ]);
