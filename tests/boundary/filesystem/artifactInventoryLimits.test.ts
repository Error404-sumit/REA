import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, it } from "vitest";

import { inventoryArtifact } from "../../fixtures/artifactInventory.js";
import { writeOrderedZip } from "../../fixtures/artifactEntryOrder.js";
import { PINNED_JADX_ARCHIVE_DIRECTORY } from "../../fixtures/android/jadxArchiveMetadata.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { ZipArtifactReader } from "../../../src/artifacts/ZipArtifactReader.js";
import {
  ZIP_MAX_ENTRIES_PER_ENGINE_ARCHIVE,
  ZIP_MAX_ENTRIES_PER_TRAVERSAL,
  ZIP_METADATA_READ_MAX_BYTES,
} from "../../../src/domain/zipArtifactBudget.js";

it("rejects ZIP inventories beyond the bounded entry count", async () => {
  const root = await createTestTempDirectory("rea-zip-entry-limit-");
  const archive = join(root, "many-directories.zip");
  const entryCount = ZIP_MAX_ENTRIES_PER_TRAVERSAL + 1;
  const entries = Array.from(
    { length: entryCount },
    (_unused, index) => `d${index.toString(36)}/`,
  );
  await writeOrderedZip(archive, entries);

  await expect(inventoryArtifact(archive)).rejects.toMatchObject({
    name: "ArtifactReaderFailure",
    reason: "limit",
    message: expect.stringContaining(
      `${ZIP_MAX_ENTRIES_PER_TRAVERSAL}-entry limit`,
    ),
  });
});

it("keeps the default ZIP bound while admitting the pinned JADX entry count", async () => {
  const root = await createTestTempDirectory("rea-zip-reader-entry-limit-");
  const archive = join(root, "many-directories.zip");
  const entries = Array.from(
    { length: PINNED_JADX_ARCHIVE_DIRECTORY.entryCount },
    (_unused, index) => `META-INF/padding-entry-${index.toString(36)}/`,
  );
  await writeOrderedZip(archive, entries);

  const reader = new ZipArtifactReader(archive, "zip");
  let entriesRead = 0;
  try {
    await expect(
      (async () => {
        for await (const entry of reader.entries()) {
          expect(entry.path).not.toBe("");
          entriesRead += 1;
        }
      })(),
    ).rejects.toMatchObject({
      name: "ArtifactReaderFailure",
      reason: "limit",
      message: expect.stringContaining(
        `${ZIP_MAX_ENTRIES_PER_TRAVERSAL}-entry limit`,
      ),
    });
    expect(entriesRead).toBe(0);
  } finally {
    await reader.close();
  }

  const engineReader = new ZipArtifactReader(
    archive,
    "zip",
    ZIP_METADATA_READ_MAX_BYTES,
    undefined,
    ZIP_MAX_ENTRIES_PER_ENGINE_ARCHIVE,
  );
  let engineEntriesRead = 0;
  try {
    for await (const entry of engineReader.entries()) {
      expect(entry.path).not.toBe("");
      engineEntriesRead += 1;
    }
    expect(engineEntriesRead).toBe(entries.length);
  } finally {
    await engineReader.close();
  }
});

it("rejects a ZIP central directory larger than the metadata read budget", async () => {
  const root = await createTestTempDirectory("rea-zip-metadata-limit-");
  const archive = join(root, "large-central-directory.zip");
  const writer = new ZipWriter(new Uint8ArrayWriter());
  const comment = "c".repeat(65_000);
  for (let index = 0; index < 129; index += 1)
    await writer.add(`entry-${index}.txt`, new TextReader("x"), { comment });
  await writeFile(archive, await writer.close());
  expect((await stat(archive)).size).toBeGreaterThan(
    ZIP_METADATA_READ_MAX_BYTES,
  );

  await expect(inventoryArtifact(archive)).rejects.toMatchObject({
    name: "ArtifactReaderFailure",
    reason: "limit",
    message: expect.stringContaining(
      `${ZIP_METADATA_READ_MAX_BYTES}-byte read budget`,
    ),
  });
});
