import { afterEach, describe, expect, test, vi } from "vitest";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type {
  ConnectorIngestResult,
  ConnectorRuntime,
} from "../src/connectors/types.ts";

// createOpenWikiConnectorTools no longer gates by run mode. It exposes all seven
// connector tools by default, honors an operator allow/deny filter, and wraps
// every tool so a thrown error becomes a model-visible result instead of a
// process-killing throw — except abort/interrupt control-flow signals, which
// must still propagate. These tests drive the tools through their public `func`
// (via `.invoke`) and mock the connector registry so a connector's `.ingest`
// throws.

const CONNECTOR_TOOL_NAMES = [
  "openwiki_list_connectors",
  "openwiki_list_mcp_tools",
  "openwiki_call_mcp_tool",
  "openwiki_ingest_connector",
  "openwiki_ingest_all_connectors",
  "openwiki_list_raw_items",
  "openwiki_read_raw_item",
] as const;

function makeConnector(
  id: ConnectorRuntime["id"],
  ingest: ConnectorRuntime["ingest"],
): ConnectorRuntime {
  return {
    backend: "direct-api",
    description: `${id} test connector`,
    displayName: id,
    id,
    ingest,
    requiredEnv: [],
    supportsAgenticDiscovery: false,
  };
}

function successResult(id: ConnectorRuntime["id"]): ConnectorIngestResult {
  return {
    connectorId: id,
    message: "ok",
    rawFiles: [],
    runId: "run-1",
    statePath: "/tmp/state.json",
    status: "success",
    warnings: [],
  };
}

function findTool(
  tools: StructuredToolInterface[],
  name: string,
): StructuredToolInterface {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Tool not found: ${name}`);
  }
  return tool;
}

async function invokeTool(
  tool: StructuredToolInterface,
  input: Record<string, unknown>,
): Promise<unknown> {
  const raw = (await tool.invoke(input)) as string;
  return JSON.parse(raw);
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("createOpenWikiConnectorTools filtering", () => {
  test("returns all seven connector tools by default", async () => {
    const { createOpenWikiConnectorTools } =
      await import("../src/connectors/tools.ts");

    const names = createOpenWikiConnectorTools().map((tool) => tool.name);

    expect(new Set(names)).toEqual(new Set(CONNECTOR_TOOL_NAMES));
    expect(names).toHaveLength(CONNECTOR_TOOL_NAMES.length);
  });

  test("deny excludes exactly the named tools", async () => {
    const { createOpenWikiConnectorTools } =
      await import("../src/connectors/tools.ts");

    const names = createOpenWikiConnectorTools({
      deny: ["openwiki_ingest_connector", "openwiki_ingest_all_connectors"],
    }).map((tool) => tool.name);

    expect(new Set(names)).toEqual(
      new Set([
        "openwiki_list_connectors",
        "openwiki_list_mcp_tools",
        "openwiki_call_mcp_tool",
        "openwiki_list_raw_items",
        "openwiki_read_raw_item",
      ]),
    );
  });

  test("a non-empty allow acts as an exclusive whitelist", async () => {
    const { createOpenWikiConnectorTools } =
      await import("../src/connectors/tools.ts");

    const names = createOpenWikiConnectorTools({
      allow: ["openwiki_list_connectors"],
    }).map((tool) => tool.name);

    expect(names).toEqual(["openwiki_list_connectors"]);
  });

  test("deny wins over allow when a name is in both", async () => {
    const { createOpenWikiConnectorTools } =
      await import("../src/connectors/tools.ts");

    const names = createOpenWikiConnectorTools({
      allow: ["openwiki_list_connectors", "openwiki_ingest_connector"],
      deny: ["openwiki_ingest_connector"],
    }).map((tool) => tool.name);

    expect(names).toEqual(["openwiki_list_connectors"]);
  });

  test("empty allow/deny lists behave like no filter", async () => {
    const { createOpenWikiConnectorTools } =
      await import("../src/connectors/tools.ts");

    const names = createOpenWikiConnectorTools({ allow: [], deny: [] }).map(
      (tool) => tool.name,
    );

    expect(new Set(names)).toEqual(new Set(CONNECTOR_TOOL_NAMES));
  });
});

describe("connector tools fail gracefully", () => {
  test("openwiki_ingest_connector returns a structured error when ingest throws", async () => {
    vi.doMock("../src/connectors/registry.ts", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../src/connectors/registry.ts")>();
      return {
        ...actual,
        createConnectorRegistry: () => ({
          x: makeConnector("x", () => {
            throw new Error(
              "Gmail refresh token is required for OAuth refresh",
            );
          }),
        }),
      };
    });

    const { createOpenWikiConnectorTools } =
      await import("../src/connectors/tools.ts");
    const tool = findTool(
      createOpenWikiConnectorTools(),
      "openwiki_ingest_connector",
    );

    const result = (await invokeTool(tool, { connectorId: "x" })) as Record<
      string,
      unknown
    >;

    expect(result).toMatchObject({
      connectorId: "x",
      status: "error",
      error: "Gmail refresh token is required for OAuth refresh",
    });
  });

  test("a non-ingest tool returns a 'Tool error:' string instead of throwing", async () => {
    // openwiki_list_mcp_tools delegates to discoverMcpConnectorTools; when that
    // underlying op throws, the wrapper must surface a benign, model-visible
    // tool result string rather than letting the throw kill the run.
    vi.doMock("../src/connectors/mcp-runtime.ts", async (importOriginal) => {
      const actual =
        await importOriginal<
          typeof import("../src/connectors/mcp-runtime.ts")
        >();
      return {
        ...actual,
        discoverMcpConnectorTools: () => {
          throw new Error("Notion MCP transport is not configured");
        },
      };
    });

    const { createOpenWikiConnectorTools } =
      await import("../src/connectors/tools.ts");
    const tool = findTool(
      createOpenWikiConnectorTools(),
      "openwiki_list_mcp_tools",
    );

    const raw = (await tool.invoke({ connectorId: "notion" })) as string;

    expect(raw).toMatch(/^Tool error: /);
    expect(raw).toContain("Notion MCP transport is not configured");
  });

  test("openwiki_ingest_all_connectors keeps partial success past a failing connector", async () => {
    vi.doMock("../src/connectors/registry.ts", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../src/connectors/registry.ts")>();
      return {
        ...actual,
        createConnectorRegistry: () => ({
          x: makeConnector("x", () => {
            throw new Error("boom");
          }),
          hackernews: makeConnector("hackernews", () =>
            Promise.resolve(successResult("hackernews")),
          ),
        }),
      };
    });

    const { createOpenWikiConnectorTools } =
      await import("../src/connectors/tools.ts");
    const tool = findTool(
      createOpenWikiConnectorTools(),
      "openwiki_ingest_all_connectors",
    );

    const result = (await invokeTool(tool, {})) as {
      results: Array<Record<string, unknown>>;
    };

    expect(result.results).toHaveLength(2);
    expect(result.results).toContainEqual(
      expect.objectContaining({
        connectorId: "x",
        status: "error",
        error: "boom",
      }),
    );
    expect(result.results).toContainEqual(
      expect.objectContaining({
        connectorId: "hackernews",
        status: "success",
      }),
    );
  });
});

describe("connector tools rethrow abort/interrupt control-flow signals", () => {
  test("openwiki_ingest_connector rejects on AbortError instead of returning a result", async () => {
    vi.doMock("../src/connectors/registry.ts", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../src/connectors/registry.ts")>();
      return {
        ...actual,
        createConnectorRegistry: () => ({
          x: makeConnector("x", () => {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            throw error;
          }),
        }),
      };
    });

    const { createOpenWikiConnectorTools } =
      await import("../src/connectors/tools.ts");
    const tool = findTool(
      createOpenWikiConnectorTools(),
      "openwiki_ingest_connector",
    );

    await expect(tool.invoke({ connectorId: "x" })).rejects.toThrow(/aborted/i);
  });

  test("a wrapped tool rejects on a LangGraph graph-interrupt", async () => {
    vi.doMock("../src/connectors/registry.ts", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../src/connectors/registry.ts")>();
      return {
        ...actual,
        createConnectorRegistry: () => ({
          x: makeConnector("x", () => {
            // Mirror @langchain/langgraph's GraphInterrupt marker shape without
            // importing it (it is a transitive-only dependency here).
            const error = new Error("interrupt");
            error.name = "GraphInterrupt";
            (error as unknown as { is_bubble_up: boolean }).is_bubble_up = true;
            throw error;
          }),
        }),
      };
    });

    const { createOpenWikiConnectorTools } =
      await import("../src/connectors/tools.ts");
    const tool = findTool(
      createOpenWikiConnectorTools(),
      "openwiki_ingest_connector",
    );

    await expect(tool.invoke({ connectorId: "x" })).rejects.toMatchObject({
      name: "GraphInterrupt",
    });
  });

  test("openwiki_ingest_all_connectors rethrows an abort mid-iteration", async () => {
    vi.doMock("../src/connectors/registry.ts", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../src/connectors/registry.ts")>();
      return {
        ...actual,
        createConnectorRegistry: () => ({
          x: makeConnector("x", () => {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            throw error;
          }),
          hackernews: makeConnector("hackernews", () =>
            Promise.resolve(successResult("hackernews")),
          ),
        }),
      };
    });

    const { createOpenWikiConnectorTools } =
      await import("../src/connectors/tools.ts");
    const tool = findTool(
      createOpenWikiConnectorTools(),
      "openwiki_ingest_all_connectors",
    );

    await expect(tool.invoke({})).rejects.toThrow(/aborted/i);
  });
});
