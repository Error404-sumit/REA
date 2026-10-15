import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { extractFile, getRawHeader, listPackage } from "@electron/asar";
import { expect, it } from "vitest";
import { asarHeaderBytes } from "../../fixtures/asarHeader.js";
import { createWhitespaceAsar } from "../../fixtures/asarWhitespace.js";
import { inventoryArtifact } from "../../fixtures/artifactInventory.js";

it.each(["", " ", "\n", "\t", "\r", " \t\r\n".repeat(3000)])(
  "preserves root and nested ASAR members and digests with JSON whitespace (%#)",
  async (whitespace) => {
    const { path, bytes, members, nested, header } =
      await createWhitespaceAsar(whitespace);
    expect(listPackage(path, { isPack: false }).sort()).toEqual([
      "/main.js",
      "/package.json",
    ]);
    expect(getRawHeader(path).header).toEqual(header.header);
    for (const [name, body] of Object.entries(members))
      expect(extractFile(path, name)).toEqual(Buffer.from(body));
    for (const input of [path, nested]) {
      const inventory = await inventoryArtifact(input);
      expect(inventory.manifest.root_format).toBe(
        input === path ? "asar" : "directory",
      );
      for (const [name, body] of Object.entries(members)) {
        expect(inventory.occurrences).toContainEqual(
          expect.objectContaining({
            logical_path: input === path ? name : `app.asar/${name}`,
          }),
        );
        expect(inventory.nodes).toContainEqual(
          expect.objectContaining({
            sha256: createHash("sha256").update(body).digest("hex"),
          }),
        );
      }
    }
    expect(await readFile(path)).toEqual(bytes);
  },
);

it("keeps upstream decode and member integrity failures after whitespace recognition", async () => {
  const { path, bytes } = await createWhitespaceAsar(" \n");
  const corrupted = Buffer.from(bytes);
  corrupted.writeUInt8(
    corrupted.readUInt8(corrupted.length - 1) ^ 1,
    corrupted.length - 1,
  );
  await writeFile(path, corrupted);
  await expect(inventoryArtifact(path)).rejects.toMatchObject({
    reason: "integrity",
  });
  await writeFile(path, asarHeaderBytes(" \n{invalid}"));
  await expect(inventoryArtifact(path)).rejects.toMatchObject({
    reason: "format",
  });
  await writeFile(path, "ordinary text, not an archive");
  const inventory = await inventoryArtifact(path);
  expect(inventory.manifest.root_format).toBe("file");
  expect(inventory.occurrences).toHaveLength(1);
});
