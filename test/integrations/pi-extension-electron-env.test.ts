import { afterEach, describe, expect, test, vi } from "vitest";

type StdioServerParams = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

const sdk = vi.hoisted(() => ({
  servers: [] as StdioServerParams[],
  inherited: { HOME: "/home/pi", PATH: "/usr/bin" },
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    callTool = vi.fn(() =>
      Promise.resolve({ content: [{ type: "text", text: "started" }] }),
    );

    async connect() {}

    async close() {}
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  getDefaultEnvironment: () => sdk.inherited,
  StdioClientTransport: class {
    onclose?: () => void;

    constructor(server: StdioServerParams) {
      sdk.servers.push(server);
    }
  },
}));

type RegisteredTool = {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
};

type Extension = (pi: {
  registerTool(tool: RegisteredTool): void;
  on(event: string, handler: () => Promise<void>): void;
}) => void;

async function loadExtension(): Promise<Extension> {
  vi.resetModules();
  const loaded = await import("../../dist/integrations/pi/openwiki.js");
  return (loaded as { default: Extension }).default;
}

async function startBridge(): Promise<void> {
  const extension = await loadExtension();
  const tools = new Map<string, RegisteredTool>();
  extension({
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    on() {},
  });
  await tools.get("openwiki_begin")!.execute("call", {});
}

const originalElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;

afterEach(() => {
  if (originalElectronRunAsNode === undefined) {
    delete process.env.ELECTRON_RUN_AS_NODE;
  } else {
    process.env.ELECTRON_RUN_AS_NODE = originalElectronRunAsNode;
  }
  sdk.servers.length = 0;
});

describe("pi bridge environment", () => {
  test("forwards ELECTRON_RUN_AS_NODE to the stdio bridge", async () => {
    process.env.ELECTRON_RUN_AS_NODE = "1";

    await startBridge();

    expect(sdk.servers[0].env).toEqual({
      ...sdk.inherited,
      ELECTRON_RUN_AS_NODE: "1",
    });
  });

  test("leaves the transport default when ELECTRON_RUN_AS_NODE is unset", async () => {
    delete process.env.ELECTRON_RUN_AS_NODE;

    await startBridge();

    expect(sdk.servers[0].env).toBeUndefined();
  });
});
