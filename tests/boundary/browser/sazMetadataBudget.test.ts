import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, it } from "vitest";

import { decodeSazCapture } from "../../../src/browser/history/SazCapture.js";
import { CaptureFormatError } from "../../../src/browser/history/CaptureFormatError.js";
import { ZIP_METADATA_READ_MAX_BYTES } from "../../../src/domain/zipArtifactBudget.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("applies the shared ZIP metadata budget to SAZ central directories", async () => {
  const root = await createTestTempDirectory("rea-saz-metadata-budget-");
  const path = join(root, "large-central-directory.saz");
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false,
  });
  const comment = "c".repeat(65_000);
  for (let index = 0; index < 129; index += 1)
    await writer.add(
      `metadata-${index}.txt`,
      new Uint8ArrayReader(new Uint8Array()),
      { comment },
    );
  const bytes = Buffer.from(await writer.close());
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("Expected ZIP end-of-central-directory");
  expect(bytes.readUInt32LE(eocd + 12)).toBeGreaterThan(
    ZIP_METADATA_READ_MAX_BYTES,
  );
  await writeFile(path, bytes);

  await expect(decodeSazCapture(path, [])).rejects.toMatchObject({
    reason: "expanded-limit",
    message: "SAZ archive exceeds the ZIP reader's resource budget.",
  } satisfies Partial<CaptureFormatError>);
});
