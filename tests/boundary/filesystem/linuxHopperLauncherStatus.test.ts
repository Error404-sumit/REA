import { createHash } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { systemLinuxHopperInstallHost } from "../../../src/application/LinuxHopper.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

/** A launcher plus a PATH-local `ldd` that leaves a marker if it is ever run. */
const launcherFixture = async (prefix: string, contents: string) => {
  const root = await createTestTempDirectory(prefix);
  const launcher = join(root, "Hopper");
  const marker = join(root, "ldd-invoked");
  await writeFile(launcher, contents);
  await writeFile(join(root, "ldd"), `#!/bin/sh\ntouch "${marker}"\n`, {
    mode: 0o755,
  });
  const host = systemLinuxHopperInstallHost({ PATH: root });
  return { host, launcher, marker, contents };
};

const lddWasInvoked = (marker: string): Promise<boolean> =>
  access(marker).then(
    () => true,
    () => false,
  );

it("reports a launcher with the verified digest as ready without a linker probe", async () => {
  const { host, launcher, marker, contents } = await launcherFixture(
    "rea-hopper-supported-launcher-",
    "test launcher fixture",
  );
  const digest = createHash("sha256").update(contents).digest("hex");

  await expect(host.launcherStatus(launcher, digest)).resolves.toBe("ready");
  await expect(lddWasInvoked(marker)).resolves.toBe(false);
});

it("rejects a launcher whose digest differs without a linker probe", async () => {
  const { host, launcher, marker } = await launcherFixture(
    "rea-hopper-unverified-launcher-",
    "untrusted launcher fixture",
  );

  await expect(host.launcherStatus(launcher, "0".repeat(64))).resolves.toBe(
    "unsupported_hopper_build",
  );
  await expect(lddWasInvoked(marker)).resolves.toBe(false);
});
