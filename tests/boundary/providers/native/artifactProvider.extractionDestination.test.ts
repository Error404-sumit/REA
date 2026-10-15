import {
  lstat,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import type { BinaryTarget } from "../../../../src/domain/binaryTargetTypes.js";
import { withArtifactClient } from "../../../support/artifactClientScope.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

it.each(["direct", "symlink"] as const)(
  "refuses a %s output path inside the source without modifying caller files",
  async (kind) => {
    const root = await createTestTempDirectory(
      "rea-extraction-source-boundary-",
    );
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(source, "payload.txt"), "caller bytes");
    let parent = source;
    if (kind === "symlink") {
      parent = join(root, "alias");
      await symlink(
        source,
        parent,
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    const target: BinaryTarget = {
      path: source,
      sourcePath: source,
      sha256: "0".repeat(64),
      kind: "archive",
      format: "asar",
    };
    const output = join(parent, "output");
    const result = await withArtifactClient(target, (client) =>
      client.execute("extract_artifact", { output_root: output }),
    );
    expect(result).toMatchObject({ ok: false, error: { reason: "path" } });
    expect(await readdir(source)).toEqual(["payload.txt"]);
    expect(await readFile(join(source, "payload.txt"), "utf8")).toBe(
      "caller bytes",
    );
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
