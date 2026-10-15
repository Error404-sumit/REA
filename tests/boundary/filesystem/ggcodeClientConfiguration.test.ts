import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { npxRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import { skillDestinations } from "../../../src/application/SetupSkill.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { systemUninstallHost } from "../../../src/application/Uninstall.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";

/**
 * The registration command setup writes on the host running the tests. Windows
 * wraps it in `cmd.exe /d /c`, so the expected entry follows the host too.
 */
const command = npxRegistrationCommand(process.platform);

beforeEach(clearClientLocationEnvironment);
afterEach(() => vi.unstubAllEnvs());

const ggcodePath = (
  home: string,
  platform: NodeJS.Platform = "linux",
  env: Parameters<typeof supportedClients>[2] = {},
) =>
  supportedClients(home, platform, env).find(({ name }) => name === "ggcode");

const registrationStatuses = (home: string) =>
  readClientRegistrationStatuses(home, undefined, {
    platform: process.platform,
    environment: {},
  });

describe("ggcode configuration paths", () => {
  it("resolves the standalone MCP config file and marker directory", () => {
    expect(ggcodePath("/home/a")).toEqual({
      name: "ggcode",
      displayName: "ggcode",
      configPath: join("/home/a", ".ggcode", "mcp_servers.yaml"),
      configPaths: [
        join("/home/a", ".ggcode", "ggcode.yaml"),
        join("/home/a", ".ggcode", "mcp_servers.yaml"),
      ],
      supersededConfigPath: join("/home/a", ".ggcode", "ggcode.yaml"),
      markerPath: join("/home/a", ".ggcode"),
      format: "ggcode",
    });
    expect(ggcodePath("/Users/a", "darwin")?.configPath).toBe(
      join("/Users/a", ".ggcode", "mcp_servers.yaml"),
    );
    expect(ggcodePath("C:\\Users\\a", "win32")?.configPath).toBe(
      join("C:\\Users\\a", ".ggcode", "mcp_servers.yaml"),
    );
  });

  it("resolves the personal skills directory beside the config root", () => {
    expect(
      skillDestinations("/home/a", ["ggcode"]).map(({ path }) => path),
    ).toEqual([
      join("/home/a", ".ggcode", "skills", "reverse-engineer-anything"),
    ]);
  });
});

describe("ggcode YAML registration", () => {
  const ggcodeClient = async () => {
    const home = await createTestTempDirectory("rea-ggcode-");
    const client = ggcodePath(home, process.platform);
    if (client?.markerPath === undefined)
      throw new Error("missing ggcode client");
    await mkdir(client.markerPath, { recursive: true });
    return { home, client };
  };

  const readServers = async (path: string) =>
    parse(await readFile(path, "utf8"));

  it("creates mcp_servers.yaml as a named sequence when it is missing", async () => {
    const { home, client } = await ggcodeClient();

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const servers = await readServers(client.configPath);
    expect(servers).toEqual([
      {
        name: "rea",
        type: "stdio",
        command: command[0],
        args: command.slice(1),
      },
    ]);

    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
    expect(
      (await registrationStatuses(home)).find(
        ({ client: name }) => name === "ggcode",
      ),
    ).toMatchObject({ state: "aligned", command });
  });

  it("upserts rea while preserving unrelated entries, order and comments", async () => {
    const { client } = await ggcodeClient();
    await writeFile(
      client.configPath,
      `# my servers
- name: alpha
  command: alpha-cmd
  args: ["serve"]
- name: rea
  command: outdated
# trailing note
`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const text = await readFile(client.configPath, "utf8");
    expect(text).toContain("# my servers");
    expect(text).toContain("# trailing note");
    const servers = parse(text);
    expect(servers).toEqual([
      { name: "alpha", command: "alpha-cmd", args: ["serve"] },
      {
        name: "rea",
        type: "stdio",
        command: command[0],
        args: command.slice(1),
      },
    ]);
  });

  it("registers into an empty config file", async () => {
    const { client } = await ggcodeClient();
    await writeFile(client.configPath, "");
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const servers = await readServers(client.configPath);
    expect(servers).toEqual([
      {
        name: "rea",
        type: "stdio",
        command: command[0],
        args: command.slice(1),
      },
    ]);
  });
});

describe("ggcode legacy in-main layering", () => {
  const ggcodeClient = async () => {
    const home = await createTestTempDirectory("rea-ggcode-");
    const client = ggcodePath(home, process.platform);
    if (client?.markerPath === undefined)
      throw new Error("missing ggcode client");
    await mkdir(client.markerPath, { recursive: true });
    return { home, client };
  };

  const readServers = async (path: string) =>
    parse(await readFile(path, "utf8"));

  it("seeds a fresh standalone file with the in-main ggcode.yaml servers it supersedes", async () => {
    const { home, client } = await ggcodeClient();
    const mainConfig = join(home, ".ggcode", "ggcode.yaml");
    const mainText = `model: demo
mcp_servers:
  - name: legacy
    command: legacy-cmd
    args: ["serve"]
`;
    await writeFile(mainConfig, mainText);

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const servers = await readServers(client.configPath);
    expect(servers).toEqual([
      { name: "legacy", command: "legacy-cmd", args: ["serve"] },
      {
        name: "rea",
        type: "stdio",
        command: command[0],
        args: command.slice(1),
      },
    ]);
    // The legacy file stays as written; ggcode ignores its section now.
    expect(await readFile(mainConfig, "utf8")).toBe(mainText);
  });

  it("does not resurrect superseded in-main servers beside an existing file", async () => {
    const { home, client } = await ggcodeClient();
    await writeFile(
      join(home, ".ggcode", "ggcode.yaml"),
      `mcp_servers:
  - name: legacy
    command: legacy-cmd
`,
    );
    await writeFile(
      client.configPath,
      `- name: alpha
  command: alpha-cmd
`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const servers = await readServers(client.configPath);
    expect(servers.map(({ name }: { name: string }) => name)).toEqual([
      "alpha",
      "rea",
    ]);
  });

  it("reports an aligned legacy in-main registration while no standalone file exists", async () => {
    const { home } = await ggcodeClient();
    await writeFile(
      join(home, ".ggcode", "ggcode.yaml"),
      `model: demo
mcp_servers:
  - name: rea
    type: stdio
    command: ${JSON.stringify(command[0])}
    args: ${JSON.stringify(command.slice(1))}
`,
    );

    expect(
      (await registrationStatuses(home)).find(
        ({ client: name }) => name === "ggcode",
      ),
    ).toMatchObject({ state: "aligned", command });
  });

  it("rejects malformed YAML without changing the file", async () => {
    const { client } = await ggcodeClient();
    const malformed = "- name: alpha\n  command: [unterminated\n";
    await writeFile(client.configPath, malformed);

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("failed");
    expect(await readFile(client.configPath, "utf8")).toBe(malformed);
  });

  it("removes only the rea entry on uninstall", async () => {
    const { home, client } = await ggcodeClient();
    await writeFile(
      client.configPath,
      `- name: other
  command: other-server
`,
    );
    await configureClientConfiguration(client, {}, command);

    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    const servers = await readServers(client.configPath);
    expect(servers).toEqual([{ name: "other", command: "other-server" }]);
  });
});
