import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import { createPackage } from "@electron/asar";
import { expect, it } from "vitest";

import { extractArtifact } from "../../../src/artifacts/extraction/ArtifactExtraction.js";
import { SafeOutputTree } from "../../../src/artifacts/SafeOutputTree.js";
import { asarHeaderBytes } from "../../fixtures/asarHeader.js";
import {
  inventoryArtifact,
  withArtifactResourceScope,
} from "../../fixtures/artifactInventory.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const NAMES = ["a:b.txt", "nested/c:d.txt", "ordinary.txt"];
const CONTENT = Buffer.from("exact member bytes\n");
const DIGEST = createHash("sha256").update(CONTENT).digest("hex");

// The reader is the first stage that owns these names, so a colon member must
// survive inventory on every host. Extraction needs a POSIX destination,
// because Windows cannot materialize a regular file whose name holds a colon.
it("keeps a colon-named ASAR member through inventory on every platform", async () => {
  const root = await createTestTempDirectory("rea-colon-listing-");
  const path = join(root, "input.asar");
  await writeFile(
    path,
    asarHeaderBytes(
      JSON.stringify({
        files: {
          "a:b.txt": { size: 0, offset: "0" },
          "ab:c.txt": { size: 0, offset: "0" },
        },
      }),
    ),
  );
  const inventory = await inventoryArtifact(path);
  expect(
    inventory.occurrences
      .map(({ logical_path }) => logical_path)
      .filter((logical_path) => logical_path.includes(":"))
      .sort(),
  ).toEqual(["a:b.txt", "ab:c.txt"]);
  expect(
    inventory.occurrences.find(({ logical_path }) => logical_path === "a:b.txt"),
  ).toMatchObject({ entry_kind: "file", hash_status: "verified" });
});

it.skipIf(process.platform === "win32").each(["directory", "asar"] as const)(
  "inventories and extracts literal POSIX colon names from %s without changing names",
  async (format) => {
    const root = await createTestTempDirectory("rea-literal-colon-");
    const source = join(root, "source");
    await mkdir(join(source, "nested"), { recursive: true });
    for (const name of NAMES) await writeFile(join(source, name), CONTENT);
    const input = format === "directory" ? source : join(root, "input.asar");
    if (format === "asar") await createPackage(source, input);

    const inventory = await inventoryArtifact(input);
    for (const name of NAMES) {
      const occurrence = inventory.occurrences.find(
        ({ logical_path }) => logical_path === name,
      );
      expect(occurrence).toMatchObject({
        entry_kind: "file",
        hash_status: "verified",
      });
      expect(
        inventory.nodes.find(
          ({ artifact_id }) => artifact_id === occurrence?.artifact_id,
        ),
      ).toMatchObject({ sha256: DIGEST, size: CONTENT.length });
    }

    const output = join(root, "output");
    const extracted = await withArtifactResourceScope((resourceScope) =>
      extractArtifact({
        inputPath: input,
        // The owner checks lstat first and selects the directory reader;
        // BinaryTarget formats have no separate directory tag.
        inputFormat: "asar",
        outputRoot: output,
        environment: {},
        integrityPolicy: "fail",
        resourceScope,
      }),
    );
    expect(
      extracted.artifacts.map(({ relative_path }) => relative_path).sort(),
    ).toEqual([...NAMES].sort());
    for (const name of NAMES)
      expect(await readFile(join(output, name))).toEqual(CONTENT);
  },
);

it.each(NAMES.filter((name) => name.includes(":")))(
  "rejects colon interpretation at a Windows destination before materializing %j",
  async (name) => {
    const root = await createTestTempDirectory("rea-colon-output-");
    const output = join(root, "output");
    const tree = await SafeOutputTree.create(output, "win32");
    const stream = Readable.from(CONTENT);
    try {
      await expect(
        tree.write(name, stream, { sha256: DIGEST, bytes: CONTENT.length }),
      ).rejects.toMatchObject({
        reason: "path",
        message: expect.stringContaining(
          "Windows destination cannot materialize artifact path as a regular file",
        ),
      });
      expect(stream.destroyed).toBe(true);
      expect(await readdir(output)).toEqual([]);
    } finally {
      expect(await tree.rollback()).toMatchObject({ status: "complete" });
    }
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
