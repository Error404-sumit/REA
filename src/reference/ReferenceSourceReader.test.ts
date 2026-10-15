import { describe, expect, it } from "vitest";

import { reconcileSymlinksBelowUnreadableDirectories } from "./ReferenceSourceReader.js";
import type { ReferenceSourceEntry } from "./ReferenceSourceReaderTypes.js";

describe("reference source reader reconciliation", () => {
  it("keeps an unobserved link target below an unreadable directory unknown", () => {
    const entries: ReferenceSourceEntry[] = [
      {
        status: "read",
        kind: "symlink",
        path: "alias.txt",
        target: "hidden/target.txt",
        targetState: "internal",
      },
      {
        status: "failed",
        kind: "directory",
        path: "hidden",
        code: "io",
        message: "EACCES",
      },
      {
        status: "read",
        kind: "file",
        path: "visible.txt",
        bytes: new Uint8Array([1]),
        size: 1,
      },
    ];

    reconcileSymlinksBelowUnreadableDirectories(entries);

    expect(entries).toContainEqual({
      status: "failed",
      kind: "symlink",
      path: "alias.txt",
      code: "io",
      message:
        "Symbolic link target is inside a directory that could not be enumerated",
    });
    expect(entries).toContainEqual(
      expect.objectContaining({ path: "visible.txt", status: "read" }),
    );
  });

  it("retains verified internal targets and sibling-prefix targets", () => {
    const entries: ReferenceSourceEntry[] = [
      {
        status: "read",
        kind: "symlink",
        path: "verified-link",
        target: "hidden/observed.txt",
        targetState: "internal",
      },
      {
        status: "read",
        kind: "file",
        path: "hidden/observed.txt",
        bytes: new Uint8Array([1]),
        size: 1,
      },
      {
        status: "read",
        kind: "symlink",
        path: "sibling-link",
        target: "hidden-other/target.txt",
        targetState: "internal",
      },
      {
        status: "failed",
        kind: "directory",
        path: "hidden",
        code: "io",
        message: "EACCES",
      },
    ];

    reconcileSymlinksBelowUnreadableDirectories(entries);

    expect(entries[0]).toMatchObject({
      status: "read",
      targetState: "internal",
    });
    expect(entries[2]).toMatchObject({
      status: "read",
      targetState: "internal",
    });
  });
});
