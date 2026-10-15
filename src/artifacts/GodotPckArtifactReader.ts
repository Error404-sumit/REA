import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { Readable, Transform, pipeline } from "node:stream";

import {
  ArtifactReaderFailure,
  copyArtifactEntry,
  sameArtifactEntry,
  type ArtifactEntry,
  type ArtifactReader,
} from "./ArtifactReader.js";
import { GODOT_PCK_MAGIC } from "../domain/godotPckFormat.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
import {
  NonRegularFileReadError,
  RegularFileAdmissionFailure,
  openRegularFile,
  sameRegularFileState,
  type StableRegularFileDescriptor,
} from "../filesystem/RegularFile.js";

const PACK_DIR_ENCRYPTED = 1 << 0;
const PACK_REL_FILEBASE = 1 << 1;
const PACK_SPARSE_BUNDLE = 1 << 2;
const PACK_FILE_ENCRYPTED = 1 << 0;
const PACK_FILE_REMOVAL = 1 << 1;
/** Godot 4.0-4.3 write format 2; Godot 4.4 and later write format 3. */
const SUPPORTED_FORMAT_VERSIONS = new Set([2, 3]);
/** Path length, offset, size, MD5, and flags with an empty path. */
const MINIMUM_ENTRY_BYTES = 4 + 8 + 8 + 16 + 4;
const TRAILER_BYTES = 8 + 4;
const DIRECTORY_CHUNK_BYTES = 64 * 1024;
/** Member paths are project file paths; 4096 bytes is Linux PATH_MAX. */
const MAX_MEMBER_PATH_BYTES = 4096;
/**
 * Directory metadata is retained in memory for the reader's lifetime. A real
 * 1.6 GB export with 3937 members has a 0.4 MiB directory.
 */
const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;
const PCK_UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

/** Observed pack header facts; offsets are absolute file positions. */
export interface GodotPckHeader {
  readonly packStart: number;
  readonly packEnd: number;
  readonly embedded: boolean;
  readonly formatVersion: number;
  readonly engineVersion: string;
  readonly packFlags: number;
  readonly fileBase: number;
  readonly directoryStart: number;
  readonly fileCount: number;
}

interface GodotPckRecord {
  readonly path: string;
  readonly offset: number;
  readonly size: number;
  readonly md5: string | null;
  readonly encrypted: boolean;
}

/**
 * Godot Engine PCK adapter for standalone packs and packs embedded through the
 * executable trailer. Members are stored uncompressed, so reads are byte ranges
 * verified against each member's declared MD5.
 */
export class GodotPckArtifactReader implements ArtifactReader {
  readonly format = "godot-pck" as const;
  #handle: FileHandle | undefined;
  #owner: OwnedFileHandle | undefined;
  #header: GodotPckHeader | undefined;
  readonly #entries = new Map<
    string,
    { readonly record: GodotPckRecord; readonly metadata: ArtifactEntry }
  >();

  constructor(
    private readonly path: string,
    private readonly admitted?: StableRegularFileDescriptor,
  ) {}

  /** Header facts are available after the first `entries()` traversal. */
  header(): GodotPckHeader | undefined {
    return this.#header;
  }

  async *entries(signal?: AbortSignal): AsyncIterable<ArtifactEntry> {
    const handle = await this.#open();
    abortIfNeeded(signal);
    const size = (await handle.stat()).size;
    const header = await readPckHeader(handle, size);
    this.#header = header;
    const records = await readPckDirectory(handle, header, signal);
    for (const [index, record] of records.entries()) {
      abortIfNeeded(signal);
      const metadata: ArtifactEntry = {
        path: record.path,
        kind: "file",
        declaredSize: record.size,
        compressedSize: null,
        executable: false,
        encrypted: record.encrypted,
        byteOffset: record.offset,
        declaredSha256: null,
        unpacked: false,
        // ponytail: MD5 is checked on read and fails closed; carrying it as
        // declared integrity needs an ArtifactEntry digest-algorithm field.
        limitations:
          record.md5 === null
            ? ["Godot PCK member declares no MD5; content was not verified."]
            : [],
        adapterKey: `godot-pck-entry:${String(index)}`,
      };
      this.#entries.set(metadata.adapterKey, {
        record,
        metadata: copyArtifactEntry(metadata),
      });
      yield metadata;
    }
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    abortIfNeeded(signal);
    const stored = this.#entries.get(entry.adapterKey);
    if (stored === undefined || !sameArtifactEntry(entry, stored.metadata))
      throw new ArtifactReaderFailure(
        "integrity",
        "Godot PCK entry metadata does not match this reader's inventory",
      );
    const { record } = stored;
    if (record.encrypted)
      throw new ArtifactReaderFailure(
        "unavailable",
        `Encrypted Godot PCK member is unsupported: ${record.path}`,
      );
    const handle = await this.#open();
    const source =
      record.size === 0
        ? Readable.from([])
        : readFileHandleChunks(handle, {
            start: record.offset,
            end: record.offset + record.size - 1,
          });
    const output = verifyMember(record, signal);
    const onAbort = (): void => {
      output.destroy(cancelled());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    output.once("close", () => signal?.removeEventListener("abort", onAbort));
    // pipeline forwards source errors to `output` and destroys the source when
    // the consumer closes `output` early. Positional reads never close the
    // reader-owned handle, unlike a FileHandle read stream.
    pipeline(source, output, () => undefined);
    return output;
  }

  async close(): Promise<void> {
    if (this.#owner === undefined) return;
    await this.#owner.close();
    this.#owner = undefined;
    this.#handle = undefined;
  }

  provenance(): readonly [] {
    return [];
  }

  async #open(): Promise<FileHandle> {
    if (this.#handle !== undefined) return this.#handle;
    try {
      const handle =
        this.admitted?.handle ??
        (await openRegularFile(this.path, { symlinks: "reject" }));
      if (this.admitted === undefined)
        this.#owner = new OwnedFileHandle(handle);
      this.#handle = handle;
    } catch (cause: unknown) {
      if (cause instanceof RegularFileAdmissionFailure) {
        this.#owner = cause.owner;
        throw ArtifactReaderFailure.withCleanup(
          cause.cause instanceof NonRegularFileReadError
            ? notRegular(this.path, cause.cause)
            : cause.cause,
          ArtifactReaderFailure.cleanupObservation(
            cause.cleanupCause,
            this.path,
          ),
        );
      }
      if (cause instanceof NonRegularFileReadError)
        throw notRegular(this.path, cause);
      throw cause;
    }
    if (
      this.admitted !== undefined &&
      !sameRegularFileState(this.admitted.initial, await this.#handle.stat())
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `Godot PCK source identity changed before reading: ${this.path}`,
      );
    return this.#handle;
  }
}

/** Locate and validate the pack header, mirroring Godot's own lookup order. */
export const readPckHeader = async (
  handle: FileHandle,
  fileSize: number,
): Promise<GodotPckHeader> => {
  let packStart = 0;
  let packEnd = fileSize;
  let embedded = false;
  if ((await readUint32(handle, 0, fileSize)) !== GODOT_PCK_MAGIC) {
    if (
      fileSize < TRAILER_BYTES ||
      (await readUint32(handle, fileSize - 4, fileSize)) !== GODOT_PCK_MAGIC
    )
      throw formatFailure("no Godot PCK header or executable trailer");
    const packBytes = await readUint64(
      handle,
      fileSize - TRAILER_BYTES,
      fileSize,
    );
    if (packBytes > fileSize - TRAILER_BYTES)
      throw formatFailure("embedded pack size exceeds the file");
    packEnd = fileSize - TRAILER_BYTES;
    packStart = packEnd - packBytes;
    embedded = true;
    if ((await readUint32(handle, packStart, packEnd)) !== GODOT_PCK_MAGIC)
      throw formatFailure("embedded pack trailer does not point at a header");
  }
  const fixed = await readExact(handle, packStart, 40, packEnd);
  const formatVersion = fixed.readUInt32LE(4);
  const engineVersion = [8, 12, 16]
    .map((offset) => String(fixed.readUInt32LE(offset)))
    .join(".");
  if (!SUPPORTED_FORMAT_VERSIONS.has(formatVersion))
    throw new ArtifactReaderFailure(
      "unavailable",
      `Godot PCK format version ${String(formatVersion)} (engine ${engineVersion}) is unsupported; formats 2 and 3 are read`,
    );
  const packFlags = fixed.readUInt32LE(20);
  const unsupportedFlags =
    packFlags & ~(PACK_REL_FILEBASE | PACK_DIR_ENCRYPTED | PACK_SPARSE_BUNDLE);
  if (unsupportedFlags !== 0)
    throw new ArtifactReaderFailure(
      "unavailable",
      `Godot PCK declares unknown pack flags 0x${unsupportedFlags.toString(16)}`,
    );
  if ((packFlags & PACK_DIR_ENCRYPTED) !== 0)
    throw new ArtifactReaderFailure(
      "unavailable",
      "Godot PCK directory is encrypted; member identities are unknown",
    );
  if ((packFlags & PACK_SPARSE_BUNDLE) !== 0)
    throw new ArtifactReaderFailure(
      "unavailable",
      "Godot PCK is a sparse bundle whose member bytes live outside this file",
    );
  // Format 3 offsets are always pack-relative; format 2 opts in with a flag.
  const relative = formatVersion === 3 || (packFlags & PACK_REL_FILEBASE) !== 0;
  const fileBase = toSafeOffset(
    fixed.readBigUInt64LE(24),
    relative ? packStart : 0,
    packEnd,
    "file base",
  );
  const directoryStart =
    formatVersion === 3
      ? toSafeOffset(fixed.readBigUInt64LE(32), packStart, packEnd, "directory")
      : // Format 2: 16 reserved uint32 values follow the file base.
        packStart + 32 + 64;
  const fileCount = await readUint32(handle, directoryStart, packEnd);
  if (fileCount * MINIMUM_ENTRY_BYTES > packEnd - directoryStart - 4)
    throw formatFailure(
      `${String(fileCount)} declared members cannot fit in the pack directory`,
    );
  return {
    packStart,
    packEnd,
    embedded,
    formatVersion,
    engineVersion,
    packFlags,
    fileBase,
    directoryStart,
    fileCount,
  };
};

const readPckDirectory = async (
  handle: FileHandle,
  header: GodotPckHeader,
  signal?: AbortSignal,
): Promise<GodotPckRecord[]> => {
  const cursor = new PckCursor(
    handle,
    header.directoryStart + 4,
    header.packEnd,
  );
  const records: GodotPckRecord[] = [];
  for (let index = 0; index < header.fileCount; index += 1) {
    abortIfNeeded(signal);
    const pathBytes = await cursor.uint32();
    if (pathBytes > MAX_MEMBER_PATH_BYTES)
      throw new ArtifactReaderFailure(
        "limit",
        `Godot PCK member ${String(index)} declares a ${String(pathBytes)}-byte path, exceeding the ${String(MAX_MEMBER_PATH_BYTES)}-byte path limit`,
      );
    // The path length is bounded by the bytes left in the pack before allocation.
    const rawPath = await cursor.bytes(pathBytes);
    const offset = await cursor.uint64();
    const size = await cursor.uint64();
    const md5 = await cursor.bytes(16);
    const flags = await cursor.uint32();
    const path = pckMemberPath(rawPath);
    if ((flags & PACK_FILE_REMOVAL) !== 0)
      throw new ArtifactReaderFailure(
        "unavailable",
        `Godot patch-pack removal entries are not modeled: ${path}`,
      );
    if ((flags & ~PACK_FILE_ENCRYPTED) !== 0)
      throw new ArtifactReaderFailure(
        "unavailable",
        `Godot PCK member declares unknown flags 0x${flags.toString(16)}: ${path}`,
      );
    const start = toSafeOffset(offset, header.fileBase, header.packEnd, path);
    if (size > BigInt(header.packEnd - start))
      throw formatFailure(`member data exceeds the pack: ${path}`);
    records.push({
      path,
      offset: start,
      size: Number(size),
      md5: md5.every((byte) => byte === 0) ? null : md5.toString("hex"),
      encrypted: (flags & PACK_FILE_ENCRYPTED) !== 0,
    });
  }
  return records;
};

/** Godot stores NUL-padded UTF-8 paths, with or without the `res://` scheme. */
const pckMemberPath = (raw: Buffer): string => {
  let end = raw.length;
  while (end > 0 && raw[end - 1] === 0) end -= 1;
  let path: string;
  try {
    path = PCK_UTF8_DECODER.decode(raw.subarray(0, end));
  } catch (cause: unknown) {
    throw new ArtifactReaderFailure(
      "format",
      "Godot PCK member path is not valid UTF-8",
      { cause },
    );
  }
  const relative = path.startsWith("res://") ? path.slice(6) : path;
  if (relative.length === 0 || relative.includes("\0"))
    throw formatFailure(`invalid member path ${JSON.stringify(path)}`);
  return relative;
};

/** Sequential directory reader with bounded, chunked file reads. */
class PckCursor {
  #buffer: Buffer = Buffer.alloc(0);
  #bufferStart = 0;
  #consumed = 0;

  constructor(
    private readonly handle: FileHandle,
    private position: number,
    private readonly end: number,
  ) {}

  async bytes(length: number): Promise<Buffer> {
    if (length > this.end - this.position)
      throw formatFailure("directory entry exceeds the pack");
    this.#consumed += length;
    if (this.#consumed > MAX_DIRECTORY_BYTES)
      throw new ArtifactReaderFailure(
        "limit",
        `Godot PCK directory exceeds the ${String(MAX_DIRECTORY_BYTES)}-byte metadata budget`,
      );
    const offset = this.position - this.#bufferStart;
    if (offset < 0 || offset + length > this.#buffer.length) {
      this.#buffer = await readExact(
        this.handle,
        this.position,
        Math.min(
          Math.max(length, DIRECTORY_CHUNK_BYTES),
          this.end - this.position,
        ),
        this.end,
      );
      this.#bufferStart = this.position;
    }
    const start = this.position - this.#bufferStart;
    this.position += length;
    return this.#buffer.subarray(start, start + length);
  }

  async uint32(): Promise<number> {
    return (await this.bytes(4)).readUInt32LE(0);
  }

  async uint64(): Promise<bigint> {
    return (await this.bytes(8)).readBigUInt64LE(0);
  }
}

const verifyMember = (
  record: GodotPckRecord,
  signal?: AbortSignal,
): Transform => {
  const hash = createHash("md5");
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (signal?.aborted === true) {
        callback(cancelled());
        return;
      }
      hash.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    },
    flush(callback) {
      if (bytes !== record.size) {
        callback(formatFailure(`member ended early: ${record.path}`));
        return;
      }
      const observed = hash.digest("hex");
      if (record.md5 !== null && observed !== record.md5) {
        callback(
          new ArtifactReaderFailure(
            "integrity",
            `Godot PCK member MD5 ${observed} contradicts declared ${record.md5}: ${record.path}`,
          ),
        );
        return;
      }
      callback();
    },
  });
};

const readExact = async (
  handle: FileHandle,
  position: number,
  length: number,
  end: number,
): Promise<Buffer> => {
  if (position < 0 || length > end - position)
    throw formatFailure("read exceeds the pack");
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw formatFailure("file is truncated");
  return buffer;
};

const readUint32 = async (
  handle: FileHandle,
  position: number,
  end: number,
): Promise<number> =>
  (await readExact(handle, position, 4, end)).readUInt32LE(0);

const readUint64 = async (
  handle: FileHandle,
  position: number,
  end: number,
): Promise<number> => {
  const value = (await readExact(handle, position, 8, end)).readBigUInt64LE(0);
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw formatFailure("64-bit size exceeds the safe integer range");
  return Number(value);
};

/** Resolve `base + offset` and require it inside `[base, end]`. */
const toSafeOffset = (
  offset: bigint,
  base: number,
  end: number,
  subject: string,
): number => {
  if (offset > BigInt(end - base))
    throw formatFailure(`${subject} offset lies outside the pack`);
  return base + Number(offset);
};

const formatFailure = (detail: string): ArtifactReaderFailure =>
  new ArtifactReaderFailure("format", `Godot PCK is malformed: ${detail}`);

const notRegular = (
  path: string,
  cause: NonRegularFileReadError,
): ArtifactReaderFailure =>
  new ArtifactReaderFailure(
    "format",
    `Godot PCK source is not a regular file: ${path}`,
    { cause },
  );

const cancelled = (): ArtifactReaderFailure =>
  new ArtifactReaderFailure("cancelled", "Godot PCK operation cancelled");

const abortIfNeeded = (signal?: AbortSignal): void => {
  if (signal?.aborted === true) throw cancelled();
};
