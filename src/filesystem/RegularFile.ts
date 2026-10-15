import { constants, readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import type { BigIntStats, Stats } from "node:fs";
import { lstat, open, stat, type FileHandle } from "node:fs/promises";

import { OwnedFileHandle } from "./OwnedFileHandle.js";

/** Identifies a selected path that cannot be read as one regular file. */
export class NonRegularFileReadError extends Error {
  readonly code: "EISDIR" | "ENOTFILE";

  constructor(
    readonly path: string,
    directory: boolean,
  ) {
    super(`Selected input must be a regular file: ${path}`);
    this.name = "NonRegularFileReadError";
    this.code = directory ? "EISDIR" : "ENOTFILE";
  }
}

/** Admission failed and the opened descriptor could not be confirmed closed. */
export class RegularFileAdmissionFailure extends Error {
  override readonly cause: unknown;

  constructor(
    readonly path: string,
    admissionCause: unknown,
    readonly cleanupCause: unknown,
    readonly owner: OwnedFileHandle,
  ) {
    super(
      `Selected input failed admission and its descriptor close failed: ${path}`,
    );
    this.name = "RegularFileAdmissionFailure";
    this.cause = admissionCause;
  }
}

/** A regular input no longer matches the extent or identity admitted for reading. */
export class RegularFileChangedError extends Error {
  readonly code = "ESTALE";
  constructor(readonly path: string) {
    super(`Selected input changed while being read: ${path}`);
    this.name = "RegularFileChangedError";
  }
}

/** One admitted file descriptor and the metadata that identified its contents. */
export interface StableRegularFileDescriptor {
  readonly handle: FileHandle;
  readonly initial: Stats;
}

/** Open and verify the selected file descriptor without blocking on pipes. */
export const openRegularFile = async (
  path: string,
  options: {
    readonly symlinks: "follow" | "reject";
    readonly signal?: AbortSignal | undefined;
  },
): Promise<FileHandle> => {
  options.signal?.throwIfAborted();
  const handle = await open(
    path,
    constants.O_RDONLY |
      (constants.O_NONBLOCK ?? 0) |
      (constants.O_NOCTTY ?? 0) |
      (options.symlinks === "reject" ? (constants.O_NOFOLLOW ?? 0) : 0),
  ).catch(async (cause: unknown) => {
    const nonRegular = await nonRegularOpenFailure(
      path,
      options.symlinks,
      cause,
    );
    if (nonRegular === undefined) throw cause;
    // Cancellation during the metadata probe outranks the reclassification.
    options.signal?.throwIfAborted();
    throw nonRegular;
  });
  const owner = new OwnedFileHandle(handle);
  try {
    options.signal?.throwIfAborted();
    const metadata = await handle.stat();
    options.signal?.throwIfAborted();
    if (!metadata.isFile())
      throw new NonRegularFileReadError(path, metadata.isDirectory());
    // O_NOFOLLOW is unavailable on Windows. Recheck the name only on hosts
    // where open could have followed a symlink, while the descriptor is owned.
    if (options.symlinks === "reject" && (constants.O_NOFOLLOW ?? 0) === 0) {
      const named = await lstat(path);
      options.signal?.throwIfAborted();
      if (named.isSymbolicLink())
        throw new NonRegularFileReadError(path, false);
      if (!sameRegularFileStateAcrossPathAndDescriptor(metadata, named))
        throw new RegularFileChangedError(path);
    }
    return handle;
  } catch (cause: unknown) {
    try {
      await owner.close();
    } catch (cleanupCause: unknown) {
      throw new RegularFileAdmissionFailure(path, cause, cleanupCause, owner);
    }
    throw cause;
  }
};

/**
 * Some non-regular files cannot be opened at all: a Unix socket fails with
 * ENXIO on Linux and EOPNOTSUPP on macOS. Confirm such a failure against
 * the path's own metadata before reporting a non-regular selection.
 */
const nonRegularOpenFailure = async (
  path: string,
  symlinks: "follow" | "reject",
  cause: unknown,
): Promise<NonRegularFileReadError | undefined> => {
  // Only errors meaning "this file type cannot be opened" are reclassified;
  // permission, symlink-rejection and resource failures keep their codes.
  if (!isUnopenableFileTypeError(cause)) return undefined;
  const metadata = await (symlinks === "reject" ? lstat : stat)(path).catch(
    () => undefined,
  );
  if (metadata === undefined || metadata.isFile()) return undefined;
  return new NonRegularFileReadError(path, metadata.isDirectory());
};

// Match by errno: libuv has no name for macOS EOPNOTSUPP (102) and reports
// "Unknown system error -102" as its code.
const errnos: Partial<Record<string, number>> = osConstants.errno;
const UNOPENABLE_FILE_TYPE_ERRNOS: ReadonlySet<number> = new Set(
  [errnos.ENXIO, errnos.EOPNOTSUPP, errnos.ENOTSUP].flatMap((errno) =>
    errno === undefined ? [] : [-errno],
  ),
);

const isUnopenableFileTypeError = (cause: unknown): boolean =>
  cause instanceof Error &&
  "errno" in cause &&
  typeof cause.errno === "number" &&
  UNOPENABLE_FILE_TYPE_ERRNOS.has(cause.errno);

// S_IFMT isolates the file type from a POSIX mode value (regular file,
// directory, socket, ...). The remaining bits are the permission bits.
// Stats.mode is a Number and BigIntStats.mode is a BigInt; mixing the two in
// a bitwise operation throws a TypeError, so both masks are needed.
const FILE_TYPE_MASK = 0o170000;
const FILE_TYPE_MASK_BIGINT = 0o170000n;

const sameFileType = (
  expected: number | bigint,
  observed: number | bigint,
): boolean => {
  if (typeof expected === "bigint" && typeof observed === "bigint") {
    return (
      (expected & FILE_TYPE_MASK_BIGINT) === (observed & FILE_TYPE_MASK_BIGINT)
    );
  }
  if (typeof expected === "bigint" || typeof observed === "bigint") {
    // A Number and a BigInt cannot be mixed in one bitwise operation, so
    // normalise both sides to Number. A POSIX mode always fits in 32 bits.
    return (
      (Number(expected) & FILE_TYPE_MASK) ===
      (Number(observed) & FILE_TYPE_MASK)
    );
  }
  return (expected & FILE_TYPE_MASK) === (observed & FILE_TYPE_MASK);
};

// The host does not change during a process lifetime, so the /proc probes run
// once and their answer is cached. Without the cache every comparison would
// re-read both files synchronously.
let prootEnvironment: boolean | undefined;

export const isPRootDistroEnvironment = (
  environment: Readonly<NodeJS.ProcessEnv>,
): boolean => environment.container === "proot-distro";

export const hasPRootTemporaryMount = (mountInfo: string): boolean =>
  mountInfo.split("\n").some((line) => {
    const mountPoint = line
      .split(" ")[4]
      ?.replace(/\\([0-7]{3})/gu, (_, octal: string) =>
        String.fromCharCode(Number.parseInt(octal, 8)),
      );
    return (
      mountPoint !== undefined &&
      /(?:^|\/)proot-[a-zA-Z0-9]{6,}(?:\/|$)/u.test(mountPoint)
    );
  });

const detectPRootEnvironment = (): boolean => {
  // PRoot-Distro exports this identity variable in login/run, including its
  // minimal mode; unlike a bound /proc, it identifies the userspace runtime.
  if (isPRootDistroEnvironment(process.env)) return true;
  // Some custom runtime configurations expose PRoot in /proc/version; the
  // standard Termux bind does not, so this is only an additional marker.
  try {
    if (readFileSync("/proc/version", "utf8").includes("PRoot")) return true;
  } catch {
    // /proc/version unreadable — fall through to the mountinfo probe.
  }
  // Inspect only mountinfo's mount-point field; source paths and mount
  // options may contain unrelated names such as "/srv/proot-backups".
  try {
    if (hasPRootTemporaryMount(readFileSync("/proc/self/mountinfo", "utf8")))
      return true;
  } catch {
    // /proc/self/mountinfo unreadable — treat the host as non-PRoot.
  }
  return false;
};

/**
 * True on PRoot hosts (Termux on Android), where stat() and fstat() can
 * report different mode permission bits and ctime for the same file. Only
 * explicit path-to-descriptor comparisons use that compatibility allowance;
 * descriptor-to-descriptor checks retain strict ctime validation.
 */
const isPRootEnvironment = (): boolean => {
  prootEnvironment ??= detectPRootEnvironment();
  return prootEnvironment;
};

/** Compare snapshots with strict metadata equality for one representation. */
export const sameRegularFileState = (
  expected: Stats | BigIntStats,
  observed: Stats | BigIntStats,
): boolean => compareRegularFileState(expected, observed, false);

/**
 * Compare a path stat with a descriptor stat. PRoot can vary permission bits
 * and ctime between those representations, but same-representation reads must
 * retain strict ctime checks.
 */
export const sameRegularFileStateAcrossPathAndDescriptor = (
  expected: Stats | BigIntStats,
  observed: Stats | BigIntStats,
): boolean => compareRegularFileState(expected, observed, true);

const compareRegularFileState = (
  expected: Stats | BigIntStats,
  observed: Stats | BigIntStats,
  allowPRootRepresentationDifferences: boolean,
): boolean => {
  if (!observed.isFile()) return false;
  if (expected.dev !== observed.dev) return false;
  if (expected.ino !== observed.ino) return false;
  if (expected.size !== observed.size) return false;
  if (allowPRootRepresentationDifferences && isPRootEnvironment()) {
    if (!sameFileType(expected.mode, observed.mode)) return false;
    if ("mtimeNs" in expected && "mtimeNs" in observed) {
      if (expected.mtimeNs !== observed.mtimeNs) return false;
    } else {
      if (expected.mtimeMs !== observed.mtimeMs) return false;
    }
  } else {
    if (expected.mode !== observed.mode) return false;
    if ("mtimeNs" in expected && "mtimeNs" in observed) {
      if (expected.mtimeNs !== observed.mtimeNs) return false;
      if (expected.ctimeNs !== observed.ctimeNs) return false;
    } else {
      if (expected.mtimeMs !== observed.mtimeMs) return false;
      if (expected.ctimeMs !== observed.ctimeMs) return false;
    }
  }
  return true;
};
