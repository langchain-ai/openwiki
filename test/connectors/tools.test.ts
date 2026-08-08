import type { StructuredToolInterface } from "@langchain/core/tools";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempHomes: string[] = [];

/**
 * Records the ingest calls a mocked connector registry receives so tests can
 * assert how the tool layer coerces raw JSON input into ingest options.
 */
interface IngestCall {
  id: string;
  options: unknown;
}

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock("../../src/connectors/registry.ts");
  vi.doUnmock("../../src/connectors/mcp-runtime.ts");
  restoreEnv("HOME", originalHome);
  restoreEnv("USERPROFILE", originalUserProfile);

  await Promise.all(
    tempHomes
      .splice(0)
      .map((home) => rm(home, { force: true, recursive: true })),
  );
});

describe("connector tool definitions", () => {
  test("exposes exactly the expected tool surface", async () => {
    const tools = await loadRealTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "openwiki_call_mcp_tool",
      "openwiki_ingest_all_connectors",
      "openwiki_ingest_connector",
      "openwiki_list_connectors",
      "openwiki_list_mcp_tools",
      "openwiki_list_raw_items",
      "openwiki_read_raw_item",
    ]);
  });

  test("every tool has a description and a closed object schema", async () => {
    const tools = await loadRealTools();

    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      const schema = getRawSchema(tool);
      expect(schema.type).toBe("object");
      // Tools that take structured args pin additionalProperties:false so the
      // model cannot smuggle unexpected fields past the schema boundary. The
      // args passthrough object on call_mcp_tool is the deliberate exception.
      if (tool.name !== "openwiki_call_mcp_tool") {
        expect(schema.additionalProperties).toBe(false);
      }
    }
  });

  test("ingest tool constrains connectorId to the built-in enum", async () => {
    const tools = await loadRealTools();
    const schema = getRawSchema(getTool(tools, "openwiki_ingest_connector"));
    const connectorId = (
      schema.properties as Record<string, { enum?: string[] }>
    ).connectorId;

    expect(connectorId.enum).toEqual([
      "custom-mcp",
      "git-repo",
      "google",
      "hackernews",
      "notion",
      "slack",
      "web-search",
      "x",
    ]);
    expect(schema.required).toEqual(["connectorId"]);
  });

  test("call_mcp_tool requires connectorId and toolName and allows free-form args", async () => {
    const tools = await loadRealTools();
    const schema = getRawSchema(getTool(tools, "openwiki_call_mcp_tool"));
    const properties = schema.properties as Record<
      string,
      { additionalProperties?: boolean; enum?: string[] }
    >;

    expect(schema.required).toEqual(["connectorId", "toolName"]);
    // Only MCP-backed connectors are callable, and arbitrary tool arguments are
    // permitted because each MCP tool defines its own input schema downstream.
    expect(properties.connectorId.enum).toEqual(["custom-mcp", "notion"]);
    expect(properties.args.additionalProperties).toBe(true);
  });
});

describe("schema boundary for untrusted tool input", () => {
  // The internal coercion guards (getConnectorId, getNumberInput, etc.) sit
  // BEHIND the JSON-schema layer that .invoke enforces, so malformed input is
  // rejected at the boundary before those guards run. These cases pin that the
  // boundary is actually enforced for the arguments an LLM controls.
  test("rejects a connectorId outside the enum", async () => {
    const tools = await loadRealTools();

    await expect(
      getTool(tools, "openwiki_list_raw_items").invoke({
        connectorId: "not-a-real-connector",
      }),
    ).rejects.toThrow(/did not match expected schema/u);
  });

  test("rejects a non-numeric maxBytes", async () => {
    const tools = await loadRealTools();

    await expect(
      getTool(tools, "openwiki_read_raw_item").invoke({
        connectorId: "x",
        path: "run/file.json",
        maxBytes: "lots" as never,
      }),
    ).rejects.toThrow(/did not match expected schema/u);
  });

  test("rejects a missing required toolName", async () => {
    const tools = await loadRealTools();

    await expect(
      getTool(tools, "openwiki_call_mcp_tool").invoke({
        connectorId: "notion",
      } as never),
    ).rejects.toThrow(/did not match expected schema/u);
  });
});

describe("openwiki_list_connectors", () => {
  test("reports env presence without ever returning secret values", async () => {
    const home = await createTempHome();
    // A required-env value that must be reported as present-but-not-exposed.
    process.env.TAVILY_API_KEY = "super-secret-tavily-value";
    const tools = await loadRealTools(home);

    const result = await invokeJson<ListConnectorsResult>(
      getTool(tools, "openwiki_list_connectors"),
      {},
    );

    expect(result.note).toMatch(/Secret values are never returned/u);
    expect(result.connectors.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(result);
    // The presence-only invariant: the actual secret string must not appear in
    // the tool output under any key.
    expect(serialized).not.toContain("super-secret-tavily-value");

    for (const connector of result.connectors) {
      for (const status of connector.requiredEnvStatus) {
        expect(typeof status.set).toBe("boolean");
        expect(status).not.toHaveProperty("value");
      }
      // A fresh temp HOME has no connector config files written yet.
      expect(connector.configExists).toBe(false);
      expect(connector.readyForIngestion).toBe(false);
    }

    delete process.env.TAVILY_API_KEY;
  });

  test("marks a connector auth-configured only when all required env is set", async () => {
    const home = await createTempHome();
    const web = await readWebSearchConnector(home);
    // web-search requires TAVILY_API_KEY; drive both branches of the presence
    // check to confirm authConfigured tracks env, not config-file existence.
    delete process.env.TAVILY_API_KEY;

    let tools = await loadRealTools(home);
    let result = await invokeJson<ListConnectorsResult>(
      getTool(tools, "openwiki_list_connectors"),
      {},
    );
    expect(findConnector(result, web.id).authConfigured).toBe(false);

    process.env.TAVILY_API_KEY = "present";
    tools = await loadRealTools(home);
    result = await invokeJson<ListConnectorsResult>(
      getTool(tools, "openwiki_list_connectors"),
      {},
    );
    expect(findConnector(result, web.id).authConfigured).toBe(true);

    delete process.env.TAVILY_API_KEY;
  });
});

describe("ingestion tool delegation", () => {
  test("coerces raw input into ingest options and delegates to the registry", async () => {
    const calls: IngestCall[] = [];
    const tools = await loadToolsWithMockRegistry(calls);

    const result = await invokeJson<{ status: string }>(
      getTool(tools, "openwiki_ingest_connector"),
      {
        connectorId: "git-repo",
        limit: 5,
        streams: ["commits", "branches"],
        windowHours: 24,
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe("git-repo");
    // The tool must forward exactly the coerced options object; numbers and the
    // string array pass through, and it is the only connector invoked.
    expect(calls[0]?.options).toEqual({
      limit: 5,
      streams: ["commits", "branches"],
      windowHours: 24,
    });
    expect(result.status).toBe("success");
  });

  test("defaults absent optional ingest options to undefined", async () => {
    const calls: IngestCall[] = [];
    const tools = await loadToolsWithMockRegistry(calls);

    await invokeJson(getTool(tools, "openwiki_ingest_connector"), {
      connectorId: "git-repo",
    });

    expect(calls[0]?.options).toEqual({
      limit: undefined,
      streams: undefined,
      windowHours: undefined,
    });
  });

  test("ingest_all runs every configured connector and wraps the results", async () => {
    const calls: IngestCall[] = [];
    const tools = await loadToolsWithMockRegistry(calls);

    const result = await invokeJson<{ results: { connectorId: string }[] }>(
      getTool(tools, "openwiki_ingest_all_connectors"),
      {},
    );

    // ingest_all fans out to each registry entry with no per-call options.
    expect(calls.map((call) => call.id)).toEqual(["git-repo", "notion"]);
    expect(calls.every((call) => call.options === undefined)).toBe(true);
    expect(result.results).toHaveLength(2);
  });
});

describe("mcp tool delegation", () => {
  test("list_mcp_tools delegates discovery for an MCP-backed connector", async () => {
    const tools = await loadToolsWithMockMcpRuntime({ isMcp: true });

    const result = await invokeJson<{ tools: { name: string }[] }>(
      getTool(tools, "openwiki_list_mcp_tools"),
      { connectorId: "notion" },
    );

    expect(result.tools).toEqual([{ name: "discovered_tool" }]);
  });

  test("list_mcp_tools rejects a connector that is not MCP-backed", async () => {
    // Defense in depth beyond the schema enum: even a schema-valid connectorId
    // is refused if the runtime does not classify it as MCP-backed.
    const tools = await loadToolsWithMockMcpRuntime({ isMcp: false });

    await expect(
      getTool(tools, "openwiki_list_mcp_tools").invoke({
        connectorId: "notion",
      }),
    ).rejects.toThrow(/not MCP-backed/u);
  });

  test("call_mcp_tool forwards the exact tool name and args", async () => {
    const calls: { name: string; args: unknown }[] = [];
    const tools = await loadToolsWithMockMcpRuntime({ isMcp: true, calls });

    await invokeJson(getTool(tools, "openwiki_call_mcp_tool"), {
      connectorId: "notion",
      toolName: "search_pages",
      args: { query: "Applied AI" },
    });

    expect(calls[0]?.name).toBe("search_pages");
    expect(calls[0]?.args).toEqual({ query: "Applied AI" });
  });

  test("call_mcp_tool defaults missing args to an empty object", async () => {
    const calls: { name: string; args: unknown }[] = [];
    const tools = await loadToolsWithMockMcpRuntime({ isMcp: true, calls });

    await invokeJson(getTool(tools, "openwiki_call_mcp_tool"), {
      connectorId: "notion",
      toolName: "search_pages",
    });

    expect(calls[0]?.args).toEqual({});
  });
});

interface ListConnectorsResult {
  connectors: {
    authConfigured: boolean;
    configExists: boolean;
    id: string;
    readyForIngestion: boolean;
    requiredEnvStatus: { key: string; set: boolean }[];
  }[];
  note: string;
}

async function loadRealTools(
  home?: string,
): Promise<StructuredToolInterface[]> {
  vi.resetModules();
  if (home) {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  }
  const { createOpenWikiConnectorTools } =
    await import("../../src/connectors/tools.ts");

  return createOpenWikiConnectorTools();
}

/**
 * Loads the tools with a stubbed registry so ingestion delegation can be
 * observed without running any real connector I/O.
 */
async function loadToolsWithMockRegistry(
  calls: IngestCall[],
): Promise<StructuredToolInterface[]> {
  vi.resetModules();
  vi.doMock("../../src/connectors/registry.ts", () => ({
    isConnectorId: (value: string) => ["git-repo", "notion"].includes(value),
    createConnectorRegistry: () => ({
      "git-repo": makeFakeConnector("git-repo", calls),
      notion: makeFakeConnector("notion", calls),
    }),
  }));
  const { createOpenWikiConnectorTools } =
    await import("../../src/connectors/tools.ts");

  return createOpenWikiConnectorTools();
}

/**
 * Loads the tools with a stubbed MCP runtime so tool discovery/calls are
 * observed without spawning or contacting a live MCP server.
 */
async function loadToolsWithMockMcpRuntime(config: {
  calls?: { name: string; args: unknown }[];
  isMcp: boolean;
}): Promise<StructuredToolInterface[]> {
  vi.resetModules();
  vi.doMock("../../src/connectors/mcp-runtime.ts", () => ({
    isMcpConnectorId: () => config.isMcp,
    discoverMcpConnectorTools: () =>
      Promise.resolve({ tools: [{ name: "discovered_tool" }] }),
    callMcpConnectorTool: (
      _id: string,
      name: string,
      args: Record<string, unknown>,
    ) => {
      config.calls?.push({ name, args });
      return Promise.resolve({ ok: true });
    },
  }));
  const { createOpenWikiConnectorTools } =
    await import("../../src/connectors/tools.ts");

  return createOpenWikiConnectorTools();
}

function makeFakeConnector(id: string, calls: IngestCall[]) {
  return {
    id,
    ingest: (options?: unknown) => {
      calls.push({ id, options });
      return Promise.resolve({ connectorId: id, status: "success" });
    },
  };
}

/**
 * Reads the real web-search connector definition so tests can key off its
 * actual id/requiredEnv rather than hard-coding assumptions.
 */
async function readWebSearchConnector(home: string) {
  vi.resetModules();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const { createConnectorRegistry } =
    await import("../../src/connectors/registry.ts");
  const registry = createConnectorRegistry();

  return registry["web-search"];
}

function getTool(
  tools: StructuredToolInterface[],
  name: string,
): StructuredToolInterface {
  const tool = tools.find((candidate) => candidate.name === name);

  if (!tool) {
    throw new Error(`Missing connector tool: ${name}`);
  }

  return tool;
}

interface RawJsonSchema {
  additionalProperties?: boolean;
  properties?: Record<string, unknown>;
  required?: string[];
  type?: string;
}

function getRawSchema(tool: StructuredToolInterface): RawJsonSchema {
  return (tool as unknown as { schema: RawJsonSchema }).schema;
}

function findConnector(result: ListConnectorsResult, id: string) {
  const connector = result.connectors.find((entry) => entry.id === id);

  if (!connector) {
    throw new Error(`Connector not found in result: ${id}`);
  }

  return connector;
}

async function invokeJson<T = unknown>(
  tool: StructuredToolInterface,
  input: Record<string, unknown>,
): Promise<T> {
  const result: unknown = await tool.invoke(input);

  if (typeof result !== "string") {
    throw new Error("Expected connector tool to return a JSON string.");
  }

  return JSON.parse(result) as T;
}

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-tools-"));
  tempHomes.push(home);

  return home;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
