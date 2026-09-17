import { describe, expect, test, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  clients: [] as Array<{
    callTool: ReturnType<typeof vi.fn>;
  }>,
  calls: 0,
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    callTool = vi.fn(() => {
      sdk.calls += 1;
      if (sdk.calls === 1) return Promise.reject(new Error("transport closed"));
      return Promise.resolve({
        content: [{ type: "text", text: "recovered" }],
        structuredContent: { recovered: true },
      });
    });

    constructor() {
      sdk.clients.push(this);
    }

    async connect() {}

    async close() {}
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {},
}));

type RegisteredTool = {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
};

type Extension = (pi: {
  registerTool(tool: RegisteredTool): void;
  on(event: string, handler: () => Promise<void>): void;
}) => void;

const extension = (
  (await import("../../dist/integrations/pi/openwiki.js")) as {
    default: Extension;
  }
).default;

describe("native Pi package bridge recovery", () => {
  test("recreates MCP bridge after transport failure", async () => {
    const tools = new Map<string, RegisteredTool>();
    extension({
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
      on() {},
    });

    const begin = tools.get("openwiki_begin")!;
    await expect(begin.execute("first", {})).rejects.toThrow(
      "transport closed",
    );
    await expect(begin.execute("second", {})).resolves.toMatchObject({
      content: [{ text: "recovered" }],
    });
    expect(sdk.clients).toHaveLength(2);
  });
});
