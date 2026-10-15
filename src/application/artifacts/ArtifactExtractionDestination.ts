import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Preserve an explicit destination; otherwise choose a fresh temporary root. */
export const createArtifactExtractionDestination = (
  outputRoot?: string,
): string => outputRoot ?? join(tmpdir(), `rea-extracted-${randomUUID()}`);
