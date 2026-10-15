import { readFile } from "node:fs/promises";
import { expect } from "vitest";
import { artifactInventoryResultSchema } from "../../src/domain/artifactGraph.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import { javascriptApplicationAnalysisResultSchema } from "../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { createWhitespaceAsar } from "../fixtures/asarWhitespace.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest.for([" ", "\n", " \t\r\n".repeat(3000)])(
  "inventories and analyzes ASAR JSON whitespace through CLI and stdio MCP (%#)",
  async (whitespace, { cli }) => {
    const { path, bytes } = await createWhitespaceAsar(whitespace);
    const inspected = await cli.run({
      arguments: ["inspect-artifact", path, "--format", "json"],
    });
    expect(inspected.exitCode, inspected.stdout + inspected.stderr).toBe(0);
    expect(inspected.json, inspected.stdout + inspected.stderr).toBeDefined();
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(inspected.json).normalized_result,
    );
    const inventory = artifactInventoryResultSchema.parse(
      inspection.substeps[0]?.evidence.normalized_result,
    );
    expect(inventory.manifest.root_format).toBe("asar");
    expect(
      inventory.occurrences.map((item) => item.logical_path).sort(),
    ).toEqual([".", "main.js", "package.json"]);
    const analyzed = await cli.run({
      arguments: ["analyze-javascript-application", path, "--format", "json"],
    });
    expect(analyzed.exitCode, analyzed.stdout + analyzed.stderr).toBe(0);
    javascriptApplicationAnalysisResultSchema.parse(
      parseEvidence(analyzed.json).normalized_result,
    );
    const { call } = await connectLocalToolsMcp();
    for (const format of ["auto", "asar"]) {
      const result = await call("analyze_javascript_application", {
        input_path: path,
        format,
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      javascriptApplicationAnalysisResultSchema.parse(
        parseEvidence(result.structuredContent).normalized_result,
      );
    }
    expect(await readFile(path)).toEqual(bytes);
  },
);
