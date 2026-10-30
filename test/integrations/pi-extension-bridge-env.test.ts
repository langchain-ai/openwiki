import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * Options the extension handed to the stdio transport for one bridge.
 */
type TransportOptions = {
  command?: string;
  env?: Record<string, string>;
};

const sdk = vi.hoisted(() => ({
  transports: [] as TransportOptions[],
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect(): Promise<void> {}

    async close(): Promise<void> {}

    callTool() {
      return Promise.resolve({ content: [{ type: "text", text: "ok" }] });
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    onclose?: () => void;

    constructor(options: TransportOptions) {
      sdk.transports.push(options);
    }

    async close(): Promise<void> {}
  },
}));

type RegisteredTool = {
  name: string;
  execute(
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>;
};

type Extension = (pi: {
  registerTool(tool: RegisteredTool): void;
  on(event: string, handler: () => Promise<void>): void;
}) => void;

const realVersions = process.versions;

/**
 * Reports `process.versions` as an Electron host, a Bun-compiled host or a
 * plain Node host.
 *
 * @param runtime - Which runtime the current process should look like.
 */
function stubHostRuntime(runtime: "electron" | "bun" | "node"): void {
  Object.defineProperty(process, "versions", {
    value:
      runtime === "electron"
        ? { ...realVersions, electron: "38.0.0" }
        : runtime === "bun"
          ? { ...realVersions, bun: "1.4.3" }
          : { ...realVersions },
    configurable: true,
    enumerable: true,
    writable: false,
  });
}

/**
 * Runs one tool call through a freshly loaded extension module and returns the
 * options its bridge gave the stdio transport.
 *
 * @returns The transport options captured for the newest bridge.
 */
async function runBridgeTool(): Promise<TransportOptions> {
  vi.resetModules();
  const extension: Extension = (
    await import("../../dist/integrations/pi/openwiki.js")
  ).default;
  const tools = new Map<string, RegisteredTool>();
  extension({
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    on() {},
  });
  await tools
    .get("openwiki_begin")!
    .execute("probe", { root: "/tmp", mode: "init" });
  return sdk.transports[sdk.transports.length - 1];
}

afterEach(() => {
  Object.defineProperty(process, "versions", {
    value: realVersions,
    configurable: true,
    enumerable: true,
    writable: false,
  });
  sdk.transports.length = 0;
  delete process.env.ELECTRON_RUN_AS_NODE;
  delete process.env.BUN_BE_BUN;
  vi.unstubAllEnvs();
});

describe("native Pi package bridge environment", () => {
  test("spawns the CLI as Node when an Electron host never set ELECTRON_RUN_AS_NODE", async () => {
    stubHostRuntime("electron");
    delete process.env.ELECTRON_RUN_AS_NODE;

    const options = await runBridgeTool();

    // process.execPath is the Electron binary here, so the child only runs
    // cli.js as a Node process when the bridge sets the variable itself.
    expect(options.command).toBe(process.execPath);
    expect(options.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });

  test("forwards ELECTRON_RUN_AS_NODE when the host already exported it", async () => {
    stubHostRuntime("electron");
    vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");

    const options = await runBridgeTool();

    // The SDK's default child environment is an allowlist that drops this
    // variable, so it has to be re-exported to the child.
    expect(options.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });

  test("spawns the CLI as Bun when a standalone Bun host never set BUN_BE_BUN", async () => {
    stubHostRuntime("bun");
    delete process.env.BUN_BE_BUN;

    const options = await runBridgeTool();

    // process.execPath is the compiled Pi executable here: without this the
    // child re-runs Pi's bundled entrypoint instead of cli.js. Verified against
    // a real `bun build --compile` binary (Bun 1.4.3): with it the child prints
    // the CLI's output, without it the child runs the bundled entry.
    expect(options.command).toBe(process.execPath);
    expect(options.env).toEqual({ BUN_BE_BUN: "1" });
  });

  test("forwards BUN_BE_BUN when the host already exported it", async () => {
    stubHostRuntime("bun");
    vi.stubEnv("BUN_BE_BUN", "1");

    const options = await runBridgeTool();

    expect(options.env).toEqual({ BUN_BE_BUN: "1" });
  });

  test("keeps a plain Node host on the SDK's default child environment", async () => {
    stubHostRuntime("node");
    delete process.env.ELECTRON_RUN_AS_NODE;
    delete process.env.BUN_BE_BUN;

    const options = await runBridgeTool();

    expect(options.env).toBeUndefined();
  });
});
