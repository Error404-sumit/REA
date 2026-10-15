import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { ZipArtifactReader } from "../../../src/artifacts/ZipArtifactReader.js";
import { inventoryArtifact } from "../../fixtures/artifactInventory.js";
import { writeOrderedZip } from "../../fixtures/artifactEntryOrder.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("rejects a ZIP whose EOCD count omits central-directory entries", async () => {
  const root = await createTestTempDirectory("rea-zip-count-integrity-");
  const archive = join(root, "underreported.zip");
  await writeOrderedZip(archive, ["visible.txt", "hidden/payload.bin"]);
  const bytes = await readFile(archive);
  expect(bytes.includes(Buffer.from("hidden/payload.bin"))).toBe(true);
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("Expected ZIP end-of-central-directory");
  bytes.writeUInt16LE(1, eocd + 8);
  bytes.writeUInt16LE(1, eocd + 10);
  await writeFile(archive, bytes);

  const failure = {
    name: "ArtifactReaderFailure",
    reason: "integrity",
    message: expect.stringContaining(
      "records not accounted for by its declared entry count",
    ),
  };
  await expect(inventoryArtifact(archive)).rejects.toMatchObject(failure);

  const reader = new ZipArtifactReader(archive, "zip");
  try {
    await expect(
      (async () => {
        for await (const _entry of reader.entries()) break;
      })(),
    ).rejects.toMatchObject(failure);
  } finally {
    await reader.close();
  }
});
