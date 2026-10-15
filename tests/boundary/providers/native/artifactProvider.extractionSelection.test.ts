import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import {
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
} from "@zip.js/zip.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseBinaryTarget } from "../../../../src/application/BinaryTargetResolver.js";
import { createArtifactExtractionDestination } from "../../../../src/application/artifacts/ArtifactExtractionDestination.js";
import {
  artifactExtractionInputSchema,
  artifactExtractionExecutionSchema,
} from "../../../../src/contracts/artifactToolContracts.js";
import {
  artifactExtractionResultSchema,
  artifactInventoryResultSchema,
} from "../../../../src/domain/artifactGraph.js";
import type { BinaryTarget } from "../../../../src/domain/binaryTargetTypes.js";
import { ZipArtifactReader } from "../../../../src/artifacts/ZipArtifactReader.js";
import { selectArtifactExtractionOccurrences } from "../../../../src/artifacts/extraction/ArtifactExtractionSelection.js";
import { withArtifactClient } from "../../../support/artifactClientScope.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

afterEach(() => vi.restoreAllMocks());

const archive = async (
  entries: readonly (readonly [string, string | Uint8Array])[],
) => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (const [path, value] of entries)
    await writer.add(
      path,
      typeof value === "string"
        ? new TextReader(value)
        : new Uint8ArrayReader(value),
    );
  return writer.close();
};

const fixture = async () => {
  const root = await createTestTempDirectory("rea-selected-extraction-");
  const path = join(root, "fixture.zip");
  await writeFile(
    path,
    await archive([
      ["lib/arm64-v8a/selected.so", "native fixture"],
      ["lib/x86_64/other.so", "native fixture"],
      ["res/2f.xml", "lower"],
      ["res/2F.xml", "upper"],
    ]),
  );
  const parsed = await parseBinaryTarget(path);
  if (!parsed.ok) throw parsed.error;
  const inventory = await inventoryOf(parsed.value);
  const selected = inventory.occurrences.find(
    ({ logical_path }) => logical_path === "lib/arm64-v8a/selected.so",
  );
  if (selected === undefined)
    throw new Error("Selected fixture occurrence missing");
  return { root, path, target: parsed.value, inventory, selected };
};

const inventoryOf = async (target: BinaryTarget) => {
  const result = await withArtifactClient(target, (client) =>
    client.execute("inventory_artifact", {}),
  );
  if (!result.ok) throw result.error;
  return artifactInventoryResultSchema.parse(result.value.result);
};

const extract = (
  target: BinaryTarget,
  output: string,
  ids?: readonly string[],
  signal?: AbortSignal,
) =>
  withArtifactClient(target, (client) =>
    client.execute(
      "extract_artifact",
      artifactExtractionExecutionSchema.parse({
        output_root: output,
        ...(ids === undefined ? {} : { occurrence_ids: ids }),
      }),
      signal === undefined ? undefined : { signal },
    ),
  );

describe("selected artifact extraction", () => {
  it("selects occurrences, not shared content IDs, and avoids unselected name collisions", async () => {
    const data = await fixture();
    const output = join(data.root, "selected");
    const result = await extract(data.target, output, [
      data.selected.occurrence_id,
    ]);
    if (!result.ok) throw result.error;
    const value = artifactExtractionResultSchema.parse(result.value.result);
    expect(value.artifacts.map(({ relative_path }) => relative_path)).toEqual([
      "lib/arm64-v8a/selected.so",
    ]);
    expect(value.extraction_manifest.selected_occurrence_ids).toEqual([
      data.selected.occurrence_id,
    ]);
    expect(value.manifest).toEqual(data.inventory.manifest);
    expect(value.limitations.join(" ")).toContain("Only caller-selected");
    expect(
      await readFile(join(output, "lib/arm64-v8a/selected.so"), "utf8"),
    ).toBe("native fixture");
    expect(await readdir(output)).toEqual(["lib"]);
    await expect(lstat(join(output, "lib/x86_64"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const other = data.inventory.occurrences.find(
      ({ logical_path }) => logical_path === "lib/x86_64/other.so",
    );
    expect(other?.artifact_id).toBe(data.selected.artifact_id);
  });

  it("keeps selected manifests independent of request order and output location", async () => {
    const data = await fixture();
    const ids = data.inventory.occurrences
      .filter(
        ({ logical_path }) =>
          logical_path.startsWith("lib/") && logical_path.endsWith(".so"),
      )
      .map(({ occurrence_id }) => occurrence_id);
    const one = await extract(data.target, join(data.root, "one"), ids);
    const two = await extract(
      data.target,
      join(data.root, "two"),
      [...ids].reverse(),
    );
    if (!one.ok) throw one.error;
    if (!two.ok) throw two.error;
    const first = artifactExtractionResultSchema.parse(one.value.result);
    const second = artifactExtractionResultSchema.parse(two.value.result);
    expect(first.extraction_manifest).toEqual(second.extraction_manifest);
    expect(first.artifacts).toEqual(second.artifacts);
  });

  it("rejects unknown and root IDs before creating the destination", async () => {
    const data = await fixture();
    const root = data.inventory.occurrences.find(
      ({ logical_path }) => logical_path === ".",
    );
    if (root === undefined) throw new Error("Root occurrence missing");
    for (const [index, id] of [
      `occ_${"f".repeat(64)}`,
      root.occurrence_id,
    ].entries()) {
      const output = join(data.root, `invalid-${index}`);
      const result = await extract(data.target, output, [id]);
      expect(result).toMatchObject({
        ok: false,
        error: { _tag: "AnalysisInputError" },
      });
      await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("does not promote nested inventory records when their containing file is excluded", async () => {
    const data = await fixture();
    const container = {
      ...data.selected,
      occurrence_id: `occ_${"a".repeat(64)}`,
      logical_path: "inner.zip",
    };
    const nested = {
      ...data.selected,
      occurrence_id: `occ_${"b".repeat(64)}`,
      parent_occurrence_id: container.occurrence_id,
      logical_path: "inner.zip/nested.txt",
    };
    const occurrences = [...data.inventory.occurrences, container, nested];
    expect(() =>
      selectArtifactExtractionOccurrences(occurrences, [nested.occurrence_id]),
    ).toThrowError(
      expect.objectContaining({
        _tag: "AnalysisInputError",
        issues: [
          expect.objectContaining({
            path: ["occurrence_ids"],
            reason: "invalid_value",
            message: expect.stringContaining(
              "not a regular file or slice exposed by the active reader",
            ),
          }),
        ],
      }),
    );
    expect(
      selectArtifactExtractionOccurrences(occurrences, [
        container.occurrence_id,
      ]).selected,
    ).toEqual([container]);
  });
});

describe("selected extraction ownership and rollback", () => {
  it("never overwrites a caller-owned destination", async () => {
    const data = await fixture();
    const output = join(data.root, "existing");
    await mkdir(output);
    await writeFile(join(output, "keep.txt"), "caller data");
    const result = await extract(data.target, output, [
      data.selected.occurrence_id,
    ]);
    expect(result).toMatchObject({ ok: false, error: { reason: "path" } });
    expect(await readFile(join(output, "keep.txt"), "utf8")).toBe(
      "caller data",
    );
    expect(await readdir(output)).toEqual(["keep.txt"]);
  });

  it("honors cancellation before selection or output creation", async () => {
    const data = await fixture();
    const output = join(data.root, "cancelled");
    const controller = new AbortController();
    controller.abort();
    const result = await extract(
      data.target,
      output,
      [data.selected.occurrence_id],
      controller.signal,
    );
    expect(result).toMatchObject({ ok: false, error: { reason: "cancelled" } });
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back a selected output if bytes change between inventory and extraction", async () => {
    const data = await fixture();
    const output = join(data.root, "changed");
    const original = ZipArtifactReader.prototype.open;
    let selectedReads = 0;
    vi.spyOn(ZipArtifactReader.prototype, "open").mockImplementation(function (
      this: ZipArtifactReader,
      entry,
      signal,
    ) {
      if (entry.path === data.selected.logical_path && ++selectedReads === 2)
        return Promise.resolve(Readable.from([Buffer.from("changed bytes")]));
      return original.call(this, entry, signal);
    });
    const result = await extract(data.target, output, [
      data.selected.occurrence_id,
    ]);
    expect(result).toMatchObject({ ok: false, error: { reason: "integrity" } });
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves default all-file selection before applying any filter", async () => {
    const data = await fixture();
    const selection = selectArtifactExtractionOccurrences(
      data.inventory.occurrences,
    );
    expect(selection.selected).toBe(selection.available);
    expect(selection.selected).toHaveLength(4);
    expect(() =>
      selectArtifactExtractionOccurrences(data.inventory.occurrences, []),
    ).toThrow();
    expect(() =>
      selectArtifactExtractionOccurrences(data.inventory.occurrences, [
        data.selected.occurrence_id,
        data.selected.occurrence_id,
      ]),
    ).toThrow();
  });
});

describe("extraction caller contract", () => {
  it("keeps the temporary default and preserves an explicit absolute root", () => {
    const explicit = join(process.cwd(), "chosen-output");
    expect(createArtifactExtractionDestination(explicit)).toBe(explicit);
    expect(createArtifactExtractionDestination()).not.toBe(
      createArtifactExtractionDestination(),
    );
    expect(artifactExtractionInputSchema.parse({})).toEqual({
      integrity_policy: "fail",
    });
    expect(
      artifactExtractionInputSchema.parse({ output_root: explicit })
        .output_root,
    ).toBe(explicit);
  });

  it.each([
    { output_root: "relative" },
    { output_root: "" },
    { output_root: "/invalid\0path" },
    { occurrence_ids: [] },
    { occurrence_ids: ["not-an-occurrence"] },
    { occurrence_ids: [`occ_${"1".repeat(64)}`, `occ_${"1".repeat(64)}`] },
  ])("rejects invalid extraction options: %j", (input) => {
    expect(artifactExtractionInputSchema.safeParse(input).success).toBe(false);
  });
});
