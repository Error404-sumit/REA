import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPackage, getRawHeader } from "@electron/asar";
import { asarHeaderBytes } from "./asarHeader.js";
import { createTestTempDirectory } from "./temporaryDirectory.js";

/** Reserialize an official producer header without changing any member bytes. */
export const createWhitespaceAsar = async (whitespace: string) => {
  const root = await createTestTempDirectory("rea-asar-whitespace-");
  const source = join(root, "source");
  const nested = join(root, "nested");
  await mkdir(source);
  await mkdir(nested);
  const members = {
    "main.js": "export const answer = 42;\n",
    "package.json": '{"name":"fixture","main":"main.js"}',
  };
  for (const [name, body] of Object.entries(members))
    await writeFile(join(source, name), body);
  const originalPath = join(root, "original.asar");
  await createPackage(source, originalPath);
  const original = await readFile(originalPath);
  const header = getRawHeader(originalPath);
  const bytes = Buffer.concat([
    asarHeaderBytes(whitespace + header.headerString),
    original.subarray(8 + original.readUInt32LE(4)),
  ]);
  const path = join(nested, "app.asar");
  await writeFile(path, bytes);
  return { path, bytes, members, nested, header };
};
