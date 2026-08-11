import { beforeEach, describe, expect, test, vi } from "vitest";

// mcp-runtime brokers between the io layer and the MCP client and enforces the
// read-only tool-call policy. io and the client are mocked; the diagnostics
// redaction (isSecretLikeKey) is left real because it is part of what we assert.
vi.mock("../../src/connectors/io.ts", () => ({
  createRunId: () => "run-1",
  readConnectorConfig: vi.fn(),
  readConnectorState: () => Promise.resolve({ version: 1 }),
  updateStateWithRun: (state: Record<string, unknown>, entry: unknown) => ({
    ...state,
    runs: [entry],
    version: 1,
  }),
  writeConnectorState: vi.fn(() => Promise.resolve()),
  writeRawJson: vi.fn(() => Promise.resolve("/raw/notion/run-1/output.json")),
}));

vi.mock("../../src/connectors/mcp-client.ts", () => ({
  executeMcpTool: vi.fn(),
  listMcpTools: vi.fn(),
}));

import { readConnectorConfig, writeRawJson } from "../../src/connectors/io.ts";
import type { McpToolDescriptor } from "../../src/connectors/mcp-client.ts";
import {
  executeMcpTool,
  listMcpTools,
} from "../../src/connectors/mcp-client.ts";
import {
  callMcpConnectorTool,
  discoverMcpConnectorTools,
  isMcpConnectorId,
  sanitizeMcpTransport,
} from "../../src/connectors/mcp-runtime.ts";
import type { McpConnectorConfig } from "../../src/connectors/types.ts";

const HOSTED_NOTION_TRANSPORT = {
  type: "http",
  url: "https://mcp.notion.com/mcp",
} as McpConnectorConfig["transport"];

/**
 * Makes the (mocked) config reader return an enabled Notion MCP config.
 */
function configureNotion(overrides: Partial<McpConnectorConfig> = {}): void {
  vi.mocked(readConnectorConfig).mockResolvedValue({
    enabled: true,
    readOnlyOperations: [],
    transport: HOSTED_NOTION_TRANSPORT,
    ...overrides,
  });
}

/**
 * Makes tools/list return exactly the given descriptors.
 */
function withTools(...tools: McpToolDescriptor[]): void {
  vi.mocked(listMcpTools).mockResolvedValue({ tools } as never);
}

function tool(descriptor: Partial<McpToolDescriptor>): McpToolDescriptor {
  return descriptor as McpToolDescriptor;
}

function writtenPayload(): Record<string, unknown> {
  return vi.mocked(writeRawJson).mock.calls[0]?.[3] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isMcpConnectorId", () => {
  test("recognizes MCP connectors and rejects others", () => {
    expect(isMcpConnectorId("notion")).toBe(true);
    expect(isMcpConnectorId("custom-mcp")).toBe(true);
    expect(isMcpConnectorId("git-repo")).toBe(false);
  });
});

describe("sanitizeMcpTransport", () => {
  test("returns null for an absent transport", () => {
    expect(sanitizeMcpTransport(undefined)).toBeNull();
  });

  test("redacts env references in headers and preserves other fields", () => {
    const sanitized = sanitizeMcpTransport({
      args: ["--flag"],
      command: "notion-mcp",
      headers: {
        Authorization: "Bearer ${NOTION_TOKEN}",
        "X-Api": "$API_KEY",
        "X-Plain": "static-value",
      },
      type: "http",
      url: "https://mcp.notion.com/mcp",
    });

    expect(sanitized).toMatchObject({
      args: ["--flag"],
      command: "notion-mcp",
      headers: {
        Authorization: "Bearer <env-ref>",
        "X-Api": "<env-ref>",
        "X-Plain": "static-value",
      },
      type: "http",
      url: "https://mcp.notion.com/mcp",
    });
  });
});

describe("callMcpConnectorTool policy", () => {
  test("throws when the requested tool was not discovered", async () => {
    configureNotion();
    withTools(tool({ name: "search" }));

    await expect(callMcpConnectorTool("notion", "missing", {})).rejects.toThrow(
      "was not returned by tools/list",
    );
    expect(executeMcpTool).not.toHaveBeenCalled();
  });

  test("allows a tool flagged read-only by annotation", async () => {
    configureNotion();
    withTools(tool({ annotations: { readOnlyHint: true }, name: "do_thing" }));
    vi.mocked(executeMcpTool).mockResolvedValue({ ok: true });

    const result = await callMcpConnectorTool("notion", "do_thing", { q: "x" });

    expect(result.allowedBy).toBe("allowed by MCP readOnlyHint annotation");
    expect(result.result).toEqual({ ok: true });
    expect(executeMcpTool).toHaveBeenCalledWith(expect.anything(), "do_thing", {
      q: "x",
    });
    expect(vi.mocked(writeRawJson).mock.calls[0]?.[2]).toBe(
      "mcp-tool-result.json",
    );
  });

  test("allows a tool explicitly listed in allowedTools", async () => {
    configureNotion({ allowedTools: ["custom_tool"] });
    withTools(tool({ name: "custom_tool" }));
    vi.mocked(executeMcpTool).mockResolvedValue("ok");

    const result = await callMcpConnectorTool("notion", "custom_tool", {});

    expect(result.allowedBy).toBe("allowed by connector config allowedTools");
  });

  test("allows a read-only-looking hosted Notion tool", async () => {
    configureNotion();
    withTools(tool({ description: "Search pages", name: "search_pages" }));
    vi.mocked(executeMcpTool).mockResolvedValue([] as never);

    const result = await callMcpConnectorTool("notion", "search_pages", {});

    expect(result.allowedBy).toBe(
      "allowed by hosted Notion read-only tool name/description",
    );
  });

  test("does not apply the Notion name heuristic to custom-mcp", async () => {
    vi.mocked(readConnectorConfig).mockResolvedValue({
      enabled: true,
      readOnlyOperations: [],
      transport: {
        type: "http",
        url: "https://mcp.example.com/mcp",
      },
    });
    withTools(tool({ description: "Search records", name: "search_records" }));

    await expect(
      callMcpConnectorTool("custom-mcp", "search_records", {}),
    ).rejects.toThrow("is not marked read-only");
    expect(executeMcpTool).not.toHaveBeenCalled();
  });

  test("rejects a mutating tool that is not marked read-only", async () => {
    configureNotion();
    withTools(tool({ description: "Create a page", name: "create_page" }));

    await expect(
      callMcpConnectorTool("notion", "create_page", {}),
    ).rejects.toThrow("is not marked read-only");
    expect(executeMcpTool).not.toHaveBeenCalled();
  });

  test("redacts secret-like argument keys in the written raw file", async () => {
    configureNotion();
    withTools(tool({ annotations: { readOnlyHint: true }, name: "read_db" }));
    vi.mocked(executeMcpTool).mockResolvedValue({});

    await callMcpConnectorTool("notion", "read_db", {
      query: "select",
      token: "super-secret",
    });

    const args = writtenPayload().args as Record<string, unknown>;
    expect(args.token).toBe("<redacted>");
    expect(args.query).toBe("select");
  });
});

describe("discoverMcpConnectorTools", () => {
  test("lists tools, writes a sanitized discovery file, and returns them", async () => {
    configureNotion({
      transport: {
        headers: { Authorization: "Bearer ${NOTION_TOKEN}" },
        type: "http",
        url: "https://mcp.notion.com/mcp",
      },
    });
    withTools(tool({ name: "search" }), tool({ name: "fetch" }));

    const result = await discoverMcpConnectorTools("notion");

    expect(result.tools.map((entry) => entry.name)).toEqual([
      "search",
      "fetch",
    ]);
    expect(result.rawFile).toBe("/raw/notion/run-1/output.json");
    expect(result.runId).toBe("run-1");
    expect(vi.mocked(writeRawJson).mock.calls[0]?.[2]).toBe("mcp-tools.json");

    const transport = writtenPayload().transport as {
      headers: Record<string, string>;
    };
    expect(transport.headers.Authorization).toBe("Bearer <env-ref>");
  });
});
