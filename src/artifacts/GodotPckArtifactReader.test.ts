import { createHash } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { text } from "node:stream/consumers";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { openRegularFile } from "../filesystem/RegularFile.js";

import type { ArtifactEntry } from "./ArtifactReader.js";
import { GodotPckArtifactReader } from "./GodotPckArtifactReader.js";

interface Member {
  readonly path: string;
  readonly data: string;
  readonly flags?: number;
  readonly md5?: Buffer;
  readonly size?: bigint;
}

const u32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};
const u64 = (value: bigint | number): Buffer => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
};
const pad4 = (bytes: Buffer): Buffer =>
  Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)]);

/**
 * Build a pack with the layout Godot's exporter writes (and GDRE Tools
 * reproduces): format 2 places the directory after a 96-byte header and
 * members after it; format 3 stores members first and a pack-relative
 * directory offset.
 */
const buildPck = (
  version: 2 | 3,
  members: readonly Member[],
  options: { packFlags?: number; fileCount?: number } = {},
): Buffer => {
  const data: Buffer[] = [];
  const offsets: number[] = [];
  let dataBytes = 0;
  for (const member of members) {
    offsets.push(dataBytes);
    const bytes = pad4(Buffer.from(member.data));
    data.push(bytes);
    dataBytes += bytes.length;
  }
  const directory = Buffer.concat([
    u32(options.fileCount ?? members.length),
    ...members.flatMap((member, index) => {
      const path = pad4(Buffer.from(member.path));
      return [
        u32(path.length),
        path,
        u64(offsets[index] ?? 0),
        u64(member.size ?? BigInt(Buffer.byteLength(member.data))),
        member.md5 ?? createHash("md5").update(member.data).digest(),
        u32(member.flags ?? 0),
      ];
    }),
  ]);
  const headerBytes = 96;
  const fileBase = version === 2 ? headerBytes + directory.length : headerBytes;
  const header = Buffer.concat([
    Buffer.from("GDPC"),
    u32(version),
    u32(4),
    u32(6),
    u32(1),
    u32(options.packFlags ?? (version === 3 ? 2 : 0)),
    u64(fileBase),
    u64(version === 3 ? headerBytes + dataBytes : 0),
  ]);
  const paddedHeader = Buffer.concat([
    header,
    Buffer.alloc(headerBytes - header.length),
  ]);
  return version === 2
    ? Buffer.concat([paddedHeader, directory, ...data])
    : Buffer.concat([paddedHeader, ...data, directory]);
};

const embed = (pack: Buffer): Buffer =>
  Buffer.concat([
    Buffer.from("\x7fELF fake engine bytes"),
    pack,
    u64(pack.length),
    Buffer.from("GDPC"),
  ]);

const writePck = async (bytes: Buffer): Promise<string> => {
  const path = join(await createTestTempDirectory("rea-godot-pck-"), "game");
  await writeFile(path, bytes);
  return path;
};

const list = async (
  reader: GodotPckArtifactReader,
): Promise<ArtifactEntry[]> => {
  const entries: ArtifactEntry[] = [];
  for await (const entry of reader.entries()) entries.push(entry);
  return entries;
};

const withReader = async <T>(
  bytes: Buffer,
  use: (reader: GodotPckArtifactReader) => Promise<T>,
): Promise<T> => {
  const reader = new GodotPckArtifactReader(await writePck(bytes));
  try {
    return await use(reader);
  } finally {
    await reader.close();
  }
};

const members: readonly Member[] = [
  { path: "res://scenes/main.gd", data: "extends Node\n" },
  { path: "project.binary", data: "" },
  { path: "data/é.json", data: '{"session":"Session1"}' },
];

describe("GodotPckArtifactReader", () => {
  it.each([
    ["format 3 standalone", buildPck(3, members), false],
    ["format 2 standalone", buildPck(2, members), false],
    ["format 3 embedded", embed(buildPck(3, members)), true],
    [
      "format 2 embedded with relative file base",
      embed(buildPck(2, members, { packFlags: 2 })),
      true,
    ],
  ])(
    "lists and reads every member of a %s pack",
    async (_, bytes, embedded) => {
      await withReader(bytes, async (reader) => {
        const entries = await list(reader);
        expect(entries.map(({ path }) => path)).toEqual([
          "scenes/main.gd",
          "project.binary",
          "data/é.json",
        ]);
        expect(reader.header()).toMatchObject({
          embedded,
          engineVersion: "4.6.1",
          fileCount: 3,
        });
        const contents = await Promise.all(
          entries.map(async (entry) => text(await reader.open(entry))),
        );
        expect(contents).toEqual(members.map(({ data }) => data));
        expect(entries[1]?.limitations).toEqual([]);
      });
    },
  );

  it("fails closed when a member contradicts its declared MD5", async () => {
    const bytes = buildPck(3, [
      { path: "a.gd", data: "real", md5: Buffer.alloc(16, 1) },
    ]);
    await withReader(bytes, async (reader) => {
      const [entry] = await list(reader);
      if (entry === undefined) throw new Error("expected one entry");
      await expect(text(await reader.open(entry))).rejects.toMatchObject({
        reason: "integrity",
      });
    });
  });

  it("reports encrypted members without reading them", async () => {
    const bytes = buildPck(3, [{ path: "secret.gd", data: "x", flags: 1 }]);
    await withReader(bytes, async (reader) => {
      const [entry] = await list(reader);
      if (entry === undefined) throw new Error("expected one entry");
      expect(entry.encrypted).toBe(true);
      await expect(reader.open(entry)).rejects.toMatchObject({
        reason: "unavailable",
      });
    });
  });

  it.each([
    [
      "an encrypted directory",
      buildPck(3, members, { packFlags: 2 | 1 }),
      "unavailable",
    ],
    [
      "a sparse bundle",
      buildPck(3, members, { packFlags: 2 | 4 }),
      "unavailable",
    ],
    [
      "a patch removal entry",
      buildPck(3, [{ path: "gone.gd", data: "", flags: 2 }]),
      "unavailable",
    ],
    [
      "a member count that cannot fit",
      buildPck(3, members, { fileCount: 0xffff_ffff }),
      "format",
    ],
    [
      "member data beyond the pack",
      buildPck(3, [{ path: "big.bin", data: "x", size: 1n << 40n }]),
      "format",
    ],
    [
      "a Godot 3 format 1 pack",
      Buffer.concat([Buffer.from("GDPC"), u32(1), Buffer.alloc(120)]),
      "unavailable",
    ],
    ["bytes without a pack", Buffer.from("not a godot pack at all"), "format"],
    [
      "a member path longer than PATH_MAX",
      buildPck(3, [{ path: "a".repeat(4097), data: "" }]),
      "limit",
    ],
    [
      "a trailer pointing outside the file",
      Buffer.concat([
        Buffer.from("engine"),
        u64(1n << 40n),
        Buffer.from("GDPC"),
      ]),
      "format",
    ],
  ])("refuses %s", async (_, bytes, reason) => {
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason });
    });
  });
});

describe("GodotPckArtifactReader member streams", () => {
  it("types cancellation during a member read instead of crashing", async () => {
    const data = "x".repeat(4 * 1024 * 1024);
    await withReader(
      buildPck(3, [{ path: "big.bin", data }]),
      async (reader) => {
        const [entry] = await list(reader);
        if (entry === undefined) throw new Error("expected one entry");
        const controller = new AbortController();
        const stream = await reader.open(entry, controller.signal);
        const chunks = stream[Symbol.asyncIterator]();
        await chunks.next();
        controller.abort();
        await expect(chunks.next()).rejects.toMatchObject({
          reason: "cancelled",
        });
      },
    );
  });

  it("keeps the reader usable after a consumer abandons a member", async () => {
    const data = "x".repeat(4 * 1024 * 1024);
    await withReader(
      buildPck(3, [{ path: "big.bin", data }]),
      async (reader) => {
        const [entry] = await list(reader);
        if (entry === undefined) throw new Error("expected one entry");
        const abandoned = await reader.open(entry);
        await abandoned[Symbol.asyncIterator]().next();
        abandoned.destroy();
        expect((await text(await reader.open(entry))).length).toBe(data.length);
      },
    );
  });

  it("reads members from the admitted descriptor after the path is replaced", async () => {
    const path = await writePck(buildPck(3, members));
    const handle = await openRegularFile(path, { symlinks: "reject" });
    try {
      const replacement = join(dirname(path), "replacement");
      await writeFile(
        replacement,
        buildPck(3, [{ path: "other.gd", data: "" }]),
      );
      await rename(replacement, path);
      const reader = new GodotPckArtifactReader(path, {
        handle,
        initial: await handle.stat(),
      });
      const entries = await list(reader);
      expect(entries.map(({ path: member }) => member)).toEqual([
        "scenes/main.gd",
        "project.binary",
        "data/é.json",
      ]);
      await reader.close();
    } finally {
      await handle.close();
    }
  });
});
