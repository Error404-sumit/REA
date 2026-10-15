import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import { parseReferenceSourceEntries } from "./ReferenceSourceImportEntries.js";
import { historicalSourceLanguages } from "../domain/referenceSourceGraph.js";
import type { ReferenceSourceRead } from "../reference/ReferenceSourceReaderTypes.js";

it("projects an unsupported non-regular entry as unknown kind instead of file", () => {
  const read: ReferenceSourceRead = {
    root: "/selected/source",
    entries: [
      {
        status: "failed",
        kind: "other",
        path: "src/pipe",
        code: "unsupported",
        message: "Entry is not a regular file",
        size: 0,
      },
    ],
    bytesRead: 0,
    limitations: [],
  };
  const parsed = parseReferenceSourceEntries(read, new Set());
  expect(parsed.entries).toContainEqual({
    path: "src/pipe",
    kind: "unknown",
    classifications: ["unknown"],
    limitations: [
      "Entry is not a regular file Exclude this entry or replace it with a regular file.",
    ],
  });
  expect(parsed.entries.some((entry) => entry.kind === "file")).toBe(false);
});

it("keeps a failed regular file as file kind", () => {
  const read: ReferenceSourceRead = {
    root: "/selected/source",
    entries: [
      {
        status: "failed",
        kind: "file",
        path: "src/broken.ts",
        code: "io",
        message: "Entry could not be read",
      },
    ],
    bytesRead: 0,
    limitations: [],
  };
  const parsed = parseReferenceSourceEntries(read, new Set());
  expect(parsed.entries).toContainEqual({
    path: "src/broken.ts",
    kind: "file",
    sha256: null,
    size: null,
    language: null,
    classifications: ["source"],
    content_state: "unreadable",
    limitations: [
      "Entry could not be read This file could not be read. Check its permissions, then try again.",
    ],
  });
});

it("retains Kotlin source identity and language across the inventory projection", () => {
  const files = [
    [
      "MainActivity.kt",
      "import android.app.Activity\nclass MainActivity : Activity()\n",
      ["source"],
      "Kotlin",
    ],
    ["task.kts", 'println("hello")\n', ["source"], "Kotlin"],
    [
      "build.gradle.kts",
      'plugins { kotlin("jvm") version "2.3.0" }\n',
      ["manifest", "source"],
      "Kotlin",
    ],
    ["MainActivity.kt.backup", "backup\n", ["unknown"], null],
    ["Legacy.java", "class Legacy {}\n", ["source"], "Java"],
  ] as const;
  const read: ReferenceSourceRead = {
    root: "/selected/source",
    entries: files.map(([path, content]) => ({
      status: "read",
      kind: "file",
      path,
      bytes: Buffer.from(content),
      size: Buffer.byteLength(content),
    })),
    bytesRead: files.reduce(
      (sum, [, content]) => sum + Buffer.byteLength(content),
      0,
    ),
    limitations: [],
  };
  const parsed = parseReferenceSourceEntries(
    read,
    new Set(files.map(([path]) => path)),
  );
  for (const [path, content, classifications, language] of files)
    expect(parsed.entries).toContainEqual({
      path,
      kind: "file",
      language,
      classifications,
      size: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
      content_state: "hashed",
      limitations: [],
    });
  expect(historicalSourceLanguages(parsed.entries)).toEqual(["Java", "Kotlin"]);
  expect(parsed.parseFailures).toEqual([]);
  expect(parsed.relationships).toEqual([]);
});

it("prefers a sibling file over a directory index for extensionless imports", () => {
  const files = [
    ["src/main.cjs", 'require("./dep");\n'],
    ["src/dep.js", 'module.exports = "file";\n'],
    ["src/dep/index.ts", 'export const index = "directory";\n'],
  ] as const;
  const read: ReferenceSourceRead = {
    root: "/selected/source",
    entries: files.map(([path, content]) => ({
      status: "read",
      kind: "file",
      path,
      bytes: Buffer.from(content),
      size: Buffer.byteLength(content),
    })),
    bytesRead: files.reduce(
      (sum, [, content]) => sum + Buffer.byteLength(content),
      0,
    ),
    limitations: [],
  };
  const parsed = parseReferenceSourceEntries(
    read,
    new Set(files.map(([path]) => path)),
  );

  expect(parsed.relationships).toEqual([
    {
      from_path: "src/main.cjs",
      to: "src/dep.js",
      kind: "requires",
      resolution: "internal",
      parse_state: "parsed",
    },
  ]);
});

it("resolves extensionless TypeScript import-equals references to source files", () => {
  const files = [
    [
      "src/main.ts",
      'import sibling = require("./dep");\nimport indexed = require("./indexed");\nimport main = require("./pkg-source");\nimport data = require("./json-package");\n',
    ],
    ["src/dep.ts", 'export const value = "sibling";\n'],
    ["src/indexed/index.ts", 'export const value = "index";\n'],
    ["src/pkg-source/package.json", '{"main":"entry"}\n'],
    ["src/pkg-source/entry.ts", 'export const value = "package main";\n'],
    ["src/pkg-source/entry.js", 'module.exports = "emitted";\n'],
    ["src/pkg-source/index.ts", 'export const value = "fallback";\n'],
    ["src/json-package/package.json", '{"main":"data"}\n'],
    ["src/json-package/data.json", '{"answer":42}\n'],
    ["src/json-package/index.js", 'module.exports = "fallback";\n'],
  ] as const;
  const read: ReferenceSourceRead = {
    root: "/selected/source",
    entries: files.map(([path, content]) => ({
      status: "read",
      kind: "file",
      path,
      bytes: Buffer.from(content),
      size: Buffer.byteLength(content),
    })),
    bytesRead: files.reduce(
      (sum, [, content]) => sum + Buffer.byteLength(content),
      0,
    ),
    limitations: [],
  };
  const parsed = parseReferenceSourceEntries(
    read,
    new Set(files.map(([path]) => path)),
  );

  expect(parsed.relationships).toEqual([
    {
      from_path: "src/main.ts",
      to: "src/dep.ts",
      kind: "requires",
      resolution: "internal",
      parse_state: "parsed",
    },
    {
      from_path: "src/main.ts",
      to: "src/indexed/index.ts",
      kind: "requires",
      resolution: "internal",
      parse_state: "parsed",
    },
    {
      from_path: "src/main.ts",
      to: "src/pkg-source/entry.ts",
      kind: "requires",
      resolution: "internal",
      parse_state: "parsed",
    },
    {
      from_path: "src/main.ts",
      to: "src/json-package/data.json",
      kind: "requires",
      resolution: "internal",
      parse_state: "parsed",
    },
  ]);
});

it("does not implicitly resolve CJS or ESM siblings for TypeScript imports", () => {
  const files = [
    [
      "src/main.cts",
      'import cjs = require("./cjsSibling");\nimport esm = require("./mjsSibling");\n',
    ],
    ["src/cjsSibling.cjs", 'module.exports = "cjs";\n'],
    ["src/cjsSibling/index.js", 'module.exports = "index";\n'],
    ["src/mjsSibling.mjs", 'export default "esm";\n'],
    ["src/mjsSibling/index.js", 'module.exports = "index";\n'],
  ] as const;
  const read: ReferenceSourceRead = {
    root: "/selected/source",
    entries: files.map(([path, content]) => ({
      status: "read",
      kind: "file",
      path,
      bytes: Buffer.from(content),
      size: Buffer.byteLength(content),
    })),
    bytesRead: files.reduce(
      (sum, [, content]) => sum + Buffer.byteLength(content),
      0,
    ),
    limitations: [],
  };
  const parsed = parseReferenceSourceEntries(
    read,
    new Set(files.map(([path]) => path)),
  );

  expect(parsed.relationships).toEqual([
    {
      from_path: "src/main.cts",
      to: "src/cjsSibling/index.js",
      kind: "requires",
      resolution: "internal",
      parse_state: "parsed",
    },
    {
      from_path: "src/main.cts",
      to: "src/mjsSibling/index.js",
      kind: "requires",
      resolution: "internal",
      parse_state: "parsed",
    },
  ]);
});
