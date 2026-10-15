import { expect, it } from "vitest";
import { Readable } from "node:stream";
import { AsarSignature } from "./AsarSignature.js";
import {
  hashReadable,
  ARTIFACT_CLASSIFICATION_PREFIX_BYTES,
} from "./ArtifactHash.js";
import { asarHeaderBytes } from "../../tests/fixtures/asarHeader.js";

it.each(["", " ", "\t", "\r", "\n", " \t\r\n".repeat(3000)])(
  "recognizes JSON whitespace across arbitrary stream boundaries (%#)",
  async (whitespace) => {
    const bytes = asarHeaderBytes(`${whitespace}{"files":{}}`);
    const probe = new AsarSignature();
    for (const byte of bytes) probe.write(Buffer.from([byte]));
    expect(probe.matched).toBe(true);
    const result = await hashReadable(
      Readable.from([bytes.subarray(0, 8192), bytes.subarray(8192)]),
    );
    expect(result.asarHeader).toBe(true);
    expect(result.prefix.length).toBeLessThanOrEqual(
      ARTIFACT_CLASSIFICATION_PREFIX_BYTES,
    );
  },
);

it.each(["\v{}", "\f{}", "\u00a0{}", "\ufeff{}", "[]", "    ", "null"])(
  "does not treat non-object JSON or non-JSON whitespace as an ASAR signature: %j",
  (json) => {
    const probe = new AsarSignature();
    probe.write(Buffer.concat([asarHeaderBytes(json), Buffer.from("{}")]));
    expect(probe.matched).toBe(false);
  },
);

it("does not search padding or member bytes after the declared JSON extent", () => {
  const bytes = asarHeaderBytes("    {}");
  bytes.writeUInt32LE(4, 12);
  const probe = new AsarSignature();
  probe.write(bytes);
  expect(probe.matched).toBe(false);
});

it("rejects contradictory pickle extents", () => {
  const bytes = asarHeaderBytes(' {"files":{}}');
  bytes.writeUInt32LE(0xffffffff, 12);
  const probe = new AsarSignature();
  probe.write(bytes);
  expect(probe.matched).toBe(false);
});
