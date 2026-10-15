import { once } from "node:events";
import { mkdtemp, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, it, vi } from "vitest";

import {
  createPrototypeTransportCleanup,
  retirePrototypePublicClient,
} from "../../scripts/verify-ghidra-prototype-diagnostics.mjs";

it.runIf(process.platform !== "win32")(
  "waits for actual transport close after the SDK escalates to SIGKILL",
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rea-prototype-stdio-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "-e",
        `
          require('node:readline').createInterface({ input: process.stdin })
            .on('line', line => {
              const request = JSON.parse(line);
              if (request.method === 'initialize') process.stdout.write(JSON.stringify({
                jsonrpc: '2.0', id: request.id, result: {
                  protocolVersion: request.params.protocolVersion,
                  capabilities: {}, serverInfo: { name: 'controlled-child', version: '1' }
                }
              }) + '\\n');
            });
          process.on('SIGTERM', () => {});
          setInterval(() => {}, 1000);
          process.stderr.write('ready');
        `,
      ],
      stderr: "pipe",
    });
    const closeTransport = createPrototypeTransportCleanup(transport);
    let observedClose = false;
    const priorOnClose = transport.onclose;
    const closed = new Promise<void>((resolve) => {
      transport.onclose = () => {
        observedClose = true;
        priorOnClose?.();
        resolve();
      };
    });
    const client = new Client({ name: "cleanup-test", version: "1" });
    const onCleanupComplete = vi.fn(async () => {
      expect(observedClose).toBe(true);
      await rm(workspace, { recursive: true, force: true });
    });
    try {
      if (transport.stderr === null) throw new Error("Missing stderr");
      const ready = once(transport.stderr, "data");
      await client.connect(transport);
      await ready;
      await retirePrototypePublicClient({
        client,
        closeTransport,
        opened: false,
        workspace,
        onCleanupComplete,
      });
      expect(onCleanupComplete).toHaveBeenCalledTimes(1);
      await expect(access(workspace)).rejects.toThrow();
    } finally {
      await client.close();
      await closed;
      await rm(workspace, { recursive: true, force: true });
    }
  },
);

it("retains the workspace until a delayed close observation can be retried", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "rea-prototype-close-retry-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["-e", "process.stdin.resume(); process.stderr.write('ready');"],
    stderr: "pipe",
  });
  const closeTransport = createPrototypeTransportCleanup(transport, 10);
  const reportClose = transport.onclose;
  const childClosed = new Promise<void>((resolve) => {
    // Delay delivery of an actual close observation until the retry.
    transport.onclose = resolve;
  });
  const client = {
    callTool: vi.fn(),
    close: () => transport.close(),
  };
  const onCleanupComplete = vi.fn(async () => {
    await rm(workspace, { recursive: true, force: true });
  });
  try {
    if (transport.stderr === null) throw new Error("Missing stderr");
    const ready = once(transport.stderr, "data");
    await transport.start();
    await ready;
    const failure = await retirePrototypePublicClient({
      client,
      closeTransport,
      opened: false,
      workspace,
      onCleanupComplete,
    }).catch((cause: unknown) => cause);
    await childClosed;
    expect(failure).toMatchObject({
      cleanupFailure: new Error("MCP transport close was not observed"),
      resources: [workspace],
      cleanupOwner: { stop: expect.any(Function) },
    });
    expect(onCleanupComplete).not.toHaveBeenCalled();
    await expect(access(workspace)).resolves.toBeUndefined();
    reportClose?.();
    const retained = failure as { cleanupOwner: { stop(): Promise<void> } };
    await retained.cleanupOwner.stop();
    expect(onCleanupComplete).toHaveBeenCalledTimes(1);
    await expect(access(workspace)).rejects.toThrow();
  } finally {
    await transport.close();
    reportClose?.();
    await rm(workspace, { recursive: true, force: true });
  }
});

it("observes transport closure when the server cannot spawn", async () => {
  const transport = new StdioClientTransport({
    command: join(tmpdir(), "rea-missing-prototype-server", "node"),
  });
  const closeTransport = createPrototypeTransportCleanup(transport);
  const client = new Client({ name: "failed-spawn-test", version: "1" });
  try {
    await expect(client.connect(transport)).rejects.toThrow("ENOENT");
  } finally {
    await client.close();
    await closeTransport();
  }
});
