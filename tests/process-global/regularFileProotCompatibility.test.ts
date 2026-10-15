import { chmod, open, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import {
  hasPRootTemporaryMount,
  isPRootDistroEnvironment,
  sameRegularFileState,
  sameRegularFileStateAcrossPathAndDescriptor,
} from "../../src/filesystem/RegularFile.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

/** Mirrors the host probe inside sameRegularFileState. */
const isPRootHost = (): boolean => {
  if (process.env.container === "proot-distro") return true;
  try {
    if (readFileSync("/proc/version", "utf8").includes("PRoot")) return true;
  } catch {
    /* fall through */
  }
  try {
    if (hasPRootTemporaryMount(readFileSync("/proc/self/mountinfo", "utf8")))
      return true;
  } catch {
    /* fall through */
  }
  return false;
};

it("recognizes only PRoot temporary mount points", () => {
  expect(
    hasPRootTemporaryMount(
      "36 25 0:32 / /data/proot-XyZ123 rw - tmpfs tmpfs rw",
    ),
  ).toBe(true);
  expect(
    hasPRootTemporaryMount(
      "36 25 0:32 /srv/proot-backups /srv rw - ext4 /dev/proot-backups rw",
    ),
  ).toBe(false);
});

it("recognizes the PRoot-Distro identity marker", () => {
  expect(isPRootDistroEnvironment({ container: "proot-distro" })).toBe(true);
  expect(isPRootDistroEnvironment({ container: "podman" })).toBe(false);
});

it("accepts identical regular-file metadata", async () => {
  const root = await createTestTempDirectory("rea-regularfile-");
  const path = join(root, "file.bin");
  await writeFile(path, "content");

  const first = await stat(path);
  const second = await stat(path);

  expect(sameRegularFileState(first, second)).toBe(true);
});

it("rejects a changed regular file", async () => {
  const root = await createTestTempDirectory("rea-regularfile-");
  const path = join(root, "file.bin");
  await writeFile(path, "content");

  const before = await stat(path);
  await writeFile(path, "changed content");
  const after = await stat(path);

  expect(sameRegularFileState(before, after)).toBe(false);
});

it("rejects a file whose mtime moved", async () => {
  const root = await createTestTempDirectory("rea-regularfile-");
  const path = join(root, "file.bin");
  await writeFile(path, "content");

  const before = await stat(path);
  // Moving the timestamp explicitly keeps size, dev, ino and mode stable, so
  // only the timestamp comparison can detect the change.
  const future = new Date(before.mtimeMs + 10_000);
  await utimes(path, future, future);
  const after = await stat(path);

  expect(after.size).toBe(before.size);
  expect(sameRegularFileState(before, after)).toBe(false);
});

it.runIf(isPRootHost())(
  "tolerates PRoot permission-bit differences between stat calls",
  async () => {
    // Under PRoot, chmod is reflected differently by stat() and fstat() on the
    // same file. sameRegularFileState must compare only the file type.
    const root = await createTestTempDirectory("rea-regularfile-");
    const path = join(root, "file.bin");
    await writeFile(path, "content");

    const before = await stat(path);
    await chmod(path, 0o400);
    const descriptor = await open(path, "r");
    let opened: Awaited<ReturnType<typeof stat>>;
    try {
      opened = await descriptor.stat();
    } finally {
      await descriptor.close();
    }

    const currentPath = await stat(path);
    expect(sameRegularFileState(before, opened)).toBe(false);
    expect(
      sameRegularFileStateAcrossPathAndDescriptor(currentPath, opened),
    ).toBe(true);
  },
);

it("compares BigIntStats without throwing on the file-type mask", async () => {
  // BigIntStats.mode is a BigInt. The file-type comparison must not mix a
  // BigInt with the Number mask, which would throw a TypeError.
  const root = await createTestTempDirectory("rea-regularfile-");
  const path = join(root, "file.bin");
  await writeFile(path, "content");

  const first = await stat(path, { bigint: true });
  const second = await stat(path, { bigint: true });

  expect(sameRegularFileState(first, second)).toBe(true);
});

it("compares file types when mode metadata uses mixed numeric kinds", async () => {
  const root = await createTestTempDirectory("rea-regularfile-");
  const path = join(root, "file.bin");
  await writeFile(path, "content");

  const numeric = await stat(path);
  const bigintMode = {
    ...numeric,
    mode: BigInt(numeric.mode),
    isFile: () => true,
  } as unknown as import("node:fs").BigIntStats;
  const previous = process.env.container;
  process.env.container = "proot-distro";
  try {
    expect(
      sameRegularFileStateAcrossPathAndDescriptor(numeric, bigintMode),
    ).toBe(true);
    expect(
      sameRegularFileStateAcrossPathAndDescriptor(bigintMode, numeric),
    ).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.container;
    else process.env.container = previous;
  }
});

it("limits PRoot metadata tolerance to path-to-descriptor checks", () => {
  const previous = process.env.container;
  process.env.container = "proot-distro";
  try {
    const before = {
      dev: 1n,
      ino: 2n,
      size: 3n,
      mode: 0o100644n,
      mtimeNs: 4n,
      ctimeNs: 5n,
      isFile: () => true,
    } as unknown as import("node:fs").BigIntStats;
    const permissionsAndCtimeChanged = {
      ...before,
      mode: 0o100400n,
      ctimeNs: 6n,
    };
    expect(
      sameRegularFileStateAcrossPathAndDescriptor(
        before,
        permissionsAndCtimeChanged,
      ),
    ).toBe(true);
    expect(sameRegularFileState(before, permissionsAndCtimeChanged)).toBe(
      false,
    );
    expect(
      sameRegularFileStateAcrossPathAndDescriptor(before, {
        ...permissionsAndCtimeChanged,
        mtimeNs: 7n,
      }),
    ).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.container;
    else process.env.container = previous;
  }
});
