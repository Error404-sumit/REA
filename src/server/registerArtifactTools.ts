import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import {
  ARTIFACT_TOOL_CONTRACTS,
  artifactInspectionInputSchema,
  artifactExtractionInputSchema,
} from "../contracts/artifactToolContracts.js";
import { createArtifactExtractionDestination } from "../application/artifacts/ArtifactExtractionDestination.js";
import { registerEvidenceTools } from "./registerEvidenceTools.js";
import { artifactInspectionResultSchema } from "../domain/artifactInspection.js";
import {
  retainedSummaryDelivery,
  withoutDeliveryDetail,
  type EvidenceToolFamilyOptions,
} from "./retainedSummaryDelivery.js";

/** Operations whose MCP delivery may be a retained summary view. */
const SUMMARY_DELIVERY: ReadonlySet<string> = new Set([
  "inspect_artifact",
  "decode_interface_builder",
]);
/** inspect_artifact keeps an explicit detail in its Evidence parameters. */
const decodeWithoutDelivery = withoutDeliveryDetail(
  new Set(["decode_interface_builder"]),
);

/** Register deterministic artifact inventory and safe extraction operations. */
export const registerArtifactTools = (
  server: EvidenceMcpServer,
  options: EvidenceToolFamilyOptions,
): void => {
  registerEvidenceTools(server, ARTIFACT_TOOL_CONTRACTS, {
    ...options,
    ...retainedSummaryDelivery(SUMMARY_DELIVERY, options),
    parametersForExecution: (operation, parameters) => {
      if (operation === "inspect_artifact") {
        const { detail: _detail, ...execution } =
          artifactInspectionInputSchema.parse(parameters);
        return execution;
      }
      if (operation === "extract_artifact") {
        const execution = artifactExtractionInputSchema.parse(parameters);
        return {
          integrity_policy: execution.integrity_policy,
          output_root: createArtifactExtractionDestination(
            execution.output_root,
          ),
          ...(execution.occurrence_ids === undefined
            ? {}
            : { occurrence_ids: execution.occurrence_ids }),
        };
      }
      return decodeWithoutDelivery(operation, parameters);
    },
    parametersForEvidence: decodeWithoutDelivery,
    sourceEvidence: (operation, result) =>
      operation === "inspect_artifact"
        ? artifactInspectionResultSchema
            .parse(result)
            .substeps.map(({ evidence }) => evidence)
        : [],
  });
};
