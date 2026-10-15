import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { createWebTextArtifact } from "../../../src/domain/webContentArtifact.js";
import {
  captureSnapshotSchema,
  webCaptureDiffSchema,
} from "../../../src/domain/webCaptureDiffSchemas.js";
import { stableWebScriptKey } from "../../../src/domain/webInventory.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { passiveNetworkCapture } from "../../fixtures/passiveNetworkCapture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

const scriptCapture = (text: string | null, cdpHash: string | null = null) => {
  const inspection = passiveNetworkCapture([]);
  const metadata = {
    url: `${inspection.target.url}/app.js`,
    cdp_hash: cdpHash,
    length: text?.length ?? 18,
    is_module: true,
    language: "JavaScript",
    source_map_url: null,
  };
  inspection.scripts = {
    total: 1,
    items: [
      {
        ...metadata,
        script_key: stableWebScriptKey(metadata),
        origin: inspection.target.origin,
        frame_id: null,
        resource_reconciliation: {
          status: "unmatched",
          reason: "no_exact_sanitized_url",
        },
        source:
          text === null
            ? { included: false, reason: "source unavailable" }
            : {
                included: true,
                artifact: createWebTextArtifact(text, "text/javascript"),
              },
      },
    ],
  };
  return captureSnapshotSchema.parse({ inspection });
};

const writeCaptures = async (
  captures: readonly ReturnType<typeof scriptCapture>[],
) => {
  const root = await createTestTempDirectory("rea-script-comparison-");
  const paths = captures.map((_, index) => join(root, `${String(index)}.json`));
  await Promise.all(
    captures.map((capture, index) =>
      writeFile(paths[index]!, JSON.stringify(capture)),
    ),
  );
  return paths;
};

const compareScripts = async (cli: TestCli, before: string, after: string) => {
  const result = await cli.run({
    arguments: ["compare-web-captures", before, after, "--json"],
  });
  expect(result.exitCode).toBe(0);
  const evidence = parseEvidence(result.json);
  expect(evidence.operation).toBe("compare_web_captures");
  return webCaptureDiffSchema.parse(evidence.normalized_result).dimensions
    .scripts;
};

cliTest(
  "CLI compares retained script content when producer hashes are unavailable",
  async ({ cli }) => {
    const captures = [
      scriptCapture("export let x = 1;\n"),
      scriptCapture("export let x = 2;\n"),
    ];
    const paths = await writeCaptures(captures);
    for (const [left, right, status] of [
      [0, 1, "changed"],
      [1, 0, "changed"],
      [0, 0, "unchanged"],
    ] as const) {
      const compared = await compareScripts(cli, paths[left]!, paths[right]!);
      expect(compared).toMatchObject({
        status,
        total_changes: status === "changed" ? 1 : 0,
      });
      if (status === "changed")
        expect(compared.changes).toEqual([
          {
            identity: captures[0]!.inspection.scripts.items[0]!.script_key,
            change: "modified",
          },
        ]);
    }
  },
);

cliTest(
  "CLI keeps missing script content identity unknown without inventing a change",
  async ({ cli }) => {
    const known = scriptCapture("export let x = 1;\n");
    const missing = scriptCapture(null);
    missing.inspection.completeness.unavailable_sections.push("script_sources");
    const paths = await writeCaptures([known, missing, scriptCapture(null)]);
    for (const [left, right] of [
      [0, 1],
      [1, 0],
      [1, 1],
      [2, 2],
    ] as const) {
      const compared = await compareScripts(cli, paths[left]!, paths[right]!);
      expect(compared).toMatchObject({
        status: "unknown",
        total_changes: 0,
        changes: [],
        reason: expect.any(String),
      });
    }
  },
);

cliTest.for([
  {
    name: "matching producer hashes without source",
    before: null,
    after: null,
    status: "unchanged",
  },
  {
    name: "source retained on only one side with matching producer hashes",
    before: "export let x = 1;\n",
    after: null,
    status: "unchanged",
  },
  {
    name: "retained source changes despite matching producer hashes",
    before: "export let x = 1;\n",
    after: "export let x = 2;\n",
    status: "changed",
  },
] as const)(
  "CLI preserves $name",
  async ({ before, after, status }, { cli }) => {
    const paths = await writeCaptures([
      scriptCapture(before, "producer-hash"),
      scriptCapture(after, "producer-hash"),
    ]);
    for (const [left, right] of [
      [0, 1],
      [1, 0],
    ] as const) {
      const compared = await compareScripts(cli, paths[left]!, paths[right]!);
      expect(compared).toMatchObject({
        status,
        total_changes: status === "changed" ? 1 : 0,
      });
    }
  },
);

cliTest(
  "CLI preserves known script membership changes when shared content is unknown",
  async ({ cli }) => {
    const before = scriptCapture(null);
    const after = structuredClone(before);
    const added = scriptCapture(null).inspection.scripts.items[0]!;
    added.url = `${added.url}?new`;
    added.script_key = stableWebScriptKey(added);
    after.inspection.scripts.items.push(added);
    after.inspection.scripts.total = 2;
    const paths = await writeCaptures([before, after]);
    for (const [left, right, change] of [
      [0, 1, "added"],
      [1, 0, "removed"],
    ] as const) {
      expect(
        await compareScripts(cli, paths[left]!, paths[right]!),
      ).toMatchObject({
        status: "changed",
        total_changes: 1,
        changes: [{ identity: added.script_key, change }],
      });
    }
  },
);

cliTest(
  "CLI keeps duplicate script source identity unknown when retention renumbers occurrences",
  async ({ cli }) => {
    const before = scriptCapture("export let x = 1;\n");
    const base = before.inspection.scripts.items[0]!.script_key;
    const second = scriptCapture("export let x = 2;\n").inspection.scripts
      .items[0]!;
    before.inspection.scripts.items.push(second);
    before.inspection.scripts.items.sort((left, right) => {
      if (!left.source.included || !right.source.included)
        throw new Error("Expected retained fixture sources");
      return left.source.artifact.sha256.localeCompare(
        right.source.artifact.sha256,
      );
    });
    for (const [index, script] of before.inspection.scripts.items.entries())
      script.script_key = `${base}_${String(index + 1)}`;
    before.inspection.scripts.total = 2;
    const after = structuredClone(before);
    // The producer sorts retained digests before this unavailable-source reason.
    after.inspection.scripts.items.reverse();
    after.inspection.scripts.items[1]!.source = {
      included: false,
      reason: "source unavailable",
    };
    for (const [index, script] of after.inspection.scripts.items.entries())
      script.script_key = `${base}_${String(index + 1)}`;
    after.inspection.completeness.unavailable_sections.push("script_sources");
    const paths = await writeCaptures([before, after]);
    for (const [left, right] of [
      [0, 1],
      [1, 0],
    ] as const) {
      expect(
        await compareScripts(cli, paths[left]!, paths[right]!),
      ).toMatchObject({ status: "unknown", total_changes: 0, changes: [] });
    }
  },
);
