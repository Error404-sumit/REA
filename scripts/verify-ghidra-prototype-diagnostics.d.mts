/** Run source-owned producer controls and the public CLI/MCP verification lane. */
export function verifyGhidraPrototypeDiagnostics(options: {
  readonly installation: { readonly analyzeHeadlessPath: string };
  readonly entrypoint?: string;
  readonly buildFixture?: (options: {
    readonly object: string;
    readonly target: string;
  }) => Promise<void>;
}): Promise<unknown>;

/** Observe actual stdio closure and retain the observation for cleanup retries. */
export function createPrototypeTransportCleanup(
  transport: import("@modelcontextprotocol/client/stdio").StdioClientTransport,
  timeoutMs?: number,
): () => Promise<void>;

/** Retain the public transport and workspace when binary cleanup is incomplete. */
export function retirePrototypePublicClient(options: {
  readonly client: Pick<
    import("@modelcontextprotocol/client").Client,
    "callTool" | "close"
  >;
  readonly closeTransport: () => Promise<void>;
  readonly opened: boolean;
  readonly workspace: string;
  readonly primaryFailure?: unknown;
  readonly onCleanupComplete: () => Promise<void>;
}): Promise<void>;
