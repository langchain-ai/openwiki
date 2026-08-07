import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildChildEnv, listMcpTools } from "../src/connectors/mcp-client.ts";

describe("buildChildEnv", () => {
  const SECRET_KEYS = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "TAVILY_API_KEY",
    "SLACK_CLIENT_SECRET",
    "GMAIL_ACCESS_TOKEN",
    "X_REFRESH_TOKEN",
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [...SECRET_KEYS, "PATH", "MCP_SERVER_TOKEN"]) {
      saved[key] = process.env[key];
    }
    for (const key of SECRET_KEYS) {
      process.env[key] = `secret-value-for-${key}`;
    }
    process.env.PATH = "/usr/bin:/bin";
    process.env.MCP_SERVER_TOKEN = "declared-token-123";
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("does not forward OpenWiki credentials to the child env", () => {
    const childEnv = buildChildEnv({});
    for (const key of SECRET_KEYS) {
      expect(childEnv).not.toHaveProperty(key);
    }
    // A random full-process.env secret must never leak by value either.
    expect(Object.values(childEnv)).not.toContain(
      "secret-value-for-ANTHROPIC_API_KEY",
    );
  });

  test("passes through allow-listed base variables like PATH", () => {
    const childEnv = buildChildEnv({});
    expect(childEnv.PATH).toBe("/usr/bin:/bin");
  });

  test("resolves only the credentials the transport explicitly declares", () => {
    const childEnv = buildChildEnv({ MCP_TOKEN: "${MCP_SERVER_TOKEN}" });
    expect(childEnv.MCP_TOKEN).toBe("declared-token-123");
    // The source var name itself is not exposed, only the mapped target var.
    expect(childEnv).not.toHaveProperty("MCP_SERVER_TOKEN");
  });

  test("throws for an unresolvable declared reference", () => {
    expect(() => buildChildEnv({ MCP_TOKEN: "${DOES_NOT_EXIST}" })).toThrow(
      /DOES_NOT_EXIST is required/u,
    );
  });

  test("rejects invalid child env key names", () => {
    expect(() => buildChildEnv({ "bad-key": "${PATH}" })).toThrow(
      /Invalid env var reference/u,
    );
  });
});

describe("listMcpTools pagination", () => {
  const MCP_URL = "https://mcp.example.com/mcp";

  type JsonRpcCall = {
    method: string;
    params?: Record<string, unknown>;
  };

  /**
   * Stubs an HTTP MCP server that answers `initialize` and then serves the
   * given `tools/list` pages in order, recording every JSON-RPC call it saw.
   */
  function stubHttpMcpServer(pages: Record<string, unknown>[]): JsonRpcCall[] {
    const calls: JsonRpcCall[] = [];
    let pageIndex = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn((_input: unknown, init?: { body?: string }) => {
        const message = JSON.parse(init?.body ?? "{}") as {
          id?: number;
          method: string;
          params?: Record<string, unknown>;
        };
        calls.push({ method: message.method, params: message.params });

        const result =
          message.method === "tools/list"
            ? (pages[Math.min(pageIndex++, pages.length - 1)] ?? { tools: [] })
            : {};

        return Promise.resolve(
          new Response(
            JSON.stringify({ id: message.id, jsonrpc: "2.0", result }),
            { headers: { "content-type": "application/json" }, status: 200 },
          ),
        );
      }),
    );

    return calls;
  }

  function listToolsCalls(calls: JsonRpcCall[]): JsonRpcCall[] {
    return calls.filter((call) => call.method === "tools/list");
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("follows nextCursor so tools past the first page are discovered", async () => {
    const calls = stubHttpMcpServer([
      { nextCursor: "cursor-2", tools: [{ name: "page_one_tool" }] },
      { tools: [{ name: "page_two_tool" }] },
    ]);

    const result = await listMcpTools({
      transport: { type: "http", url: MCP_URL },
    });

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "page_one_tool",
      "page_two_tool",
    ]);
    // The second page must be requested with the cursor the server handed back.
    expect(listToolsCalls(calls).map((call) => call.params)).toEqual([
      {},
      { cursor: "cursor-2" },
    ]);
  });

  test("issues a single request when the server does not paginate", async () => {
    const calls = stubHttpMcpServer([{ tools: [{ name: "only_tool" }] }]);

    const result = await listMcpTools({
      transport: { type: "http", url: MCP_URL },
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(["only_tool"]);
    expect(listToolsCalls(calls)).toHaveLength(1);
  });

  test("stops instead of looping when a server repeats the same cursor", async () => {
    const calls = stubHttpMcpServer([
      { nextCursor: "stuck", tools: [{ name: "first_tool" }] },
      { nextCursor: "stuck", tools: [{ name: "second_tool" }] },
    ]);

    const result = await listMcpTools({
      transport: { type: "http", url: MCP_URL },
    });

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "first_tool",
      "second_tool",
    ]);
    expect(listToolsCalls(calls)).toHaveLength(2);
  });

  test("caps the number of pages when a server always returns a fresh cursor", async () => {
    const calls: JsonRpcCall[] = [];
    let cursorSeed = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn((_input: unknown, init?: { body?: string }) => {
        const message = JSON.parse(init?.body ?? "{}") as {
          id?: number;
          method: string;
          params?: Record<string, unknown>;
        };
        calls.push({ method: message.method, params: message.params });

        cursorSeed += 1;
        const result =
          message.method === "tools/list"
            ? {
                nextCursor: `cursor-${cursorSeed}`,
                tools: [{ name: `tool_${cursorSeed}` }],
              }
            : {};

        return Promise.resolve(
          new Response(
            JSON.stringify({ id: message.id, jsonrpc: "2.0", result }),
            { headers: { "content-type": "application/json" }, status: 200 },
          ),
        );
      }),
    );

    const result = await listMcpTools({
      transport: { type: "http", url: MCP_URL },
    });

    // Terminates on the page cap rather than following cursors forever.
    expect(listToolsCalls(calls)).toHaveLength(100);
    expect(result.tools).toHaveLength(100);
  });
});
