import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildChildEnv, listMcpTools } from "../src/connectors/mcp-client.ts";

function stubHttpMcpFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      if (typeof init?.body !== "string") {
        return Promise.reject(new Error("Expected MCP request body."));
      }

      const body = JSON.parse(init.body) as {
        id?: number;
        method?: string;
      };

      if (body.method === "notifications/initialized") {
        return Promise.resolve(new Response("", { status: 202 }));
      }

      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: body.id,
            jsonrpc: "2.0",
            result: body.method === "tools/list" ? { tools: [] } : {},
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    },
  );
  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

function mcpConfigWithHeaders(headers: Record<string, string>) {
  return {
    transport: {
      headers,
      type: "http" as const,
      url: "https://mcp.example.test/rpc",
    },
  };
}

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

describe("HTTP MCP header env templates", () => {
  const HEADER_ENV_KEYS = ["MCP_HEADER_TOKEN", "MCP_HEADER_MISSING"] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of HEADER_ENV_KEYS) {
      saved[key] = process.env[key];
    }
    process.env.MCP_HEADER_TOKEN = "declared-header-token";
    delete process.env.MCP_HEADER_MISSING;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.unstubAllGlobals();
  });

  test("resolves valid env template headers before HTTP requests", async () => {
    const fetchMock = stubHttpMcpFetch();

    await listMcpTools(
      mcpConfigWithHeaders({
        Authorization: "Bearer ${MCP_HEADER_TOKEN}",
        "X-Trace": "trace-${MCP_HEADER_TOKEN}-done",
      }),
    );

    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(init.headers.Authorization).toBe("Bearer declared-header-token");
    expect(init.headers["X-Trace"]).toBe("trace-declared-header-token-done");
  });

  test("still rejects literal secret-like header values", async () => {
    await expect(
      listMcpTools(
        mcpConfigWithHeaders({
          Authorization: "Bearer literal-token",
        }),
      ),
    ).rejects.toThrow(
      /Header Authorization must reference credentials with \$\{ENV_VAR\}/u,
    );
  });

  test.each([
    ["missing closing brace", "Bearer ${MCP_HEADER_TOKEN", /malformed/u],
    [
      "lowercase env reference",
      "Bearer ${mcp_header_token}",
      /Invalid env var reference/u,
    ],
    ["extra closing brace", "Bearer ${MCP_HEADER_TOKEN}}", /malformed/u],
    [
      "missing env value",
      "Bearer ${MCP_HEADER_MISSING}",
      /MCP_HEADER_MISSING is required/u,
    ],
  ])("rejects %s", async (_caseName, headerValue, errorPattern) => {
    await expect(
      listMcpTools(
        mcpConfigWithHeaders({
          Authorization: headerValue,
        }),
      ),
    ).rejects.toThrow(errorPattern);
  });

  test("rejects template fragments remaining after resolution", async () => {
    process.env.MCP_HEADER_TOKEN = "still-${UNRESOLVED}";

    await expect(
      listMcpTools(
        mcpConfigWithHeaders({
          Authorization: "Bearer ${MCP_HEADER_TOKEN}",
        }),
      ),
    ).rejects.toThrow(/unresolved template fragments/u);
  });
});
