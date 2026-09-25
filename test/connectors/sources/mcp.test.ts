import { beforeEach, describe, expect, test, vi } from "vitest";

// The MCP source is a config-driven branch selector over three collaborators:
// the io layer, the MCP client (tool listing / execution), and the transport
// sanitizer. All three are mocked so we assert only the branching and the
// shape of what gets written.
vi.mock("../../../src/connectors/io.ts", () => ({
  createRunId: () => "run-1",
  readConnectorConfig: vi.fn(),
  readConnectorState: () => Promise.resolve({ version: 1 }),
  updateStateWithRun: (state: Record<string, unknown>, entry: unknown) => ({
    ...state,
    runs: [entry],
    version: 1,
  }),
  writeConnectorState: vi.fn(() => Promise.resolve()),
  writeRawJson: vi.fn(() => Promise.resolve("/raw/mcp/run-1/output.json")),
}));

vi.mock("../../../src/connectors/mcp-client.ts", () => ({
  executeMcpReadOnlyOperations: vi.fn(),
  listMcpTools: vi.fn(),
}));

vi.mock("../../../src/connectors/mcp-runtime.ts", () => ({
  sanitizeMcpTransport: vi.fn(() => ({ redacted: true })),
}));

import {
  readConnectorConfig,
  writeConnectorState,
  writeRawJson,
} from "../../../src/connectors/io.ts";
import {
  executeMcpReadOnlyOperations,
  listMcpTools,
} from "../../../src/connectors/mcp-client.ts";
import { sanitizeMcpTransport } from "../../../src/connectors/mcp-runtime.ts";
import { createMcpConnector } from "../../../src/connectors/sources/mcp.ts";
import type { McpConnectorConfig } from "../../../src/connectors/types.ts";

const INPUT = {
  description: "Notion MCP",
  displayName: "Notion",
  id: "notion",
  requiredEnv: [],
} as unknown as Parameters<typeof createMcpConnector>[0];

const TRANSPORT = { command: "notion-mcp", type: "stdio" };

/**
 * Makes the (mocked) config reader return a specific MCP config for one ingest.
 */
function configure(config: Partial<McpConnectorConfig>): void {
  vi.mocked(readConnectorConfig).mockResolvedValue(config);
}

/**
 * Returns the value object handed to the (mocked) writeRawJson.
 */
function writtenPayload(): Record<string, unknown> {
  const call = vi.mocked(writeRawJson).mock.calls[0];
  return call?.[3] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mcp connector gating", () => {
  test("skips when the connector is not enabled", async () => {
    configure({ enabled: false, readOnlyOperations: [] });
    const connector = createMcpConnector(INPUT);

    const result = await connector.ingest();

    expect(result.status).toBe("skipped");
    expect(result.message).toContain("is not enabled");
    expect(result.rawFiles).toEqual([]);
    expect(writeRawJson).not.toHaveBeenCalled();
    expect(writeConnectorState).not.toHaveBeenCalled();
  });

  test("errors when the transport is missing", async () => {
    configure({ enabled: true, readOnlyOperations: [] });
    const connector = createMcpConnector(INPUT);

    const result = await connector.ingest();

    expect(result.status).toBe("error");
    expect(result.message).toBe(
      "MCP config must include transport and readOnlyOperations.",
    );
    expect(result.warnings).toEqual([
      "MCP config must include transport and readOnlyOperations.",
    ]);
    // Errors still persist a run to state so the failure is observable.
    expect(writeConnectorState).toHaveBeenCalledTimes(1);
    expect(listMcpTools).not.toHaveBeenCalled();
  });

  test("errors when readOnlyOperations is not an array", async () => {
    configure({
      enabled: true,
      readOnlyOperations: undefined,
      transport: TRANSPORT as never,
    });
    const connector = createMcpConnector(INPUT);

    const result = await connector.ingest();

    expect(result.status).toBe("error");
    expect(result.message).toBe(
      "MCP config must include transport and readOnlyOperations.",
    );
  });
});

describe("mcp connector tool discovery", () => {
  test("lists tools and skips when no read-only operations are configured", async () => {
    configure({
      enabled: true,
      readOnlyOperations: [],
      transport: TRANSPORT as never,
    });
    vi.mocked(listMcpTools).mockResolvedValue({
      tools: [{ name: "search" }, { name: "read" }],
    } as never);
    const connector = createMcpConnector(INPUT);

    const result = await connector.ingest();

    expect(result.status).toBe("skipped");
    expect(result.message).toContain("Discovered 2 MCP tool(s)");
    expect(result.warnings).toEqual([
      "No readOnlyOperations configured; listed available MCP tools instead of guessing.",
    ]);
    expect(executeMcpReadOnlyOperations).not.toHaveBeenCalled();

    expect(vi.mocked(writeRawJson).mock.calls[0]?.[2]).toBe("mcp-tools.json");
    const payload = writtenPayload();
    expect(payload.tools).toEqual([{ name: "search" }, { name: "read" }]);
    // The transport is redacted through the sanitizer before it is written.
    expect(sanitizeMcpTransport).toHaveBeenCalledWith(TRANSPORT);
    expect(payload.transport).toEqual({ redacted: true });
  });
});

describe("mcp connector read-only execution", () => {
  test("executes configured read-only operations and succeeds", async () => {
    const operations = [{ args: { q: "x" }, name: "search", type: "tool" }];
    configure({
      enabled: true,
      readOnlyOperations: operations as never,
      transport: TRANSPORT as never,
    });
    vi.mocked(executeMcpReadOnlyOperations).mockResolvedValue({
      operations: [{ name: "search", result: "ok" }],
    } as never);
    const connector = createMcpConnector(INPUT);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(result.message).toBe("Executed 1 read-only MCP operation(s).");
    expect(listMcpTools).not.toHaveBeenCalled();
    expect(executeMcpReadOnlyOperations).toHaveBeenCalledTimes(1);

    expect(vi.mocked(writeRawJson).mock.calls[0]?.[2]).toBe("mcp-results.json");
    const payload = writtenPayload();
    expect(payload.operations).toEqual([{ name: "search", result: "ok" }]);
    expect(payload.transport).toEqual({ redacted: true });
    expect(writeConnectorState).toHaveBeenCalledTimes(1);
  });

  test("merges source-instance connectorConfig over disk config", async () => {
    configure({
      enabled: false,
      readOnlyOperations: [],
      transport: TRANSPORT as never,
    });
    const operations = [{ name: "search", type: "tool" }];
    vi.mocked(executeMcpReadOnlyOperations).mockResolvedValue({
      operations: [{ name: "search", result: "ok" }],
    } as never);
    const connector = createMcpConnector({
      description: "Custom MCP",
      displayName: "Custom MCP",
      id: "custom-mcp",
      requiredEnv: [],
    });

    const result = await connector.ingest({
      connectorConfig: {
        enabled: true,
        readOnlyOperations: operations,
      },
    });

    expect(result.status).toBe("success");
    expect(executeMcpReadOnlyOperations).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        readOnlyOperations: operations,
        transport: TRANSPORT,
      }),
    );
  });
});
