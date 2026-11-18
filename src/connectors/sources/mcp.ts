import {
  createRunId,
  readConnectorConfig,
  readConnectorState,
  updateStateWithRun,
  writeConnectorState,
  writeRawJson,
} from "../io.js";
import { openWikiConnectorsDisplayPath } from "../../config/openwiki-home.js";
import { executeMcpReadOnlyOperations, listMcpTools } from "../mcp-client.js";
import { sanitizeMcpTransport } from "../mcp-runtime.js";
import type {
  ConnectorDefinition,
  ConnectorId,
  ConnectorIngestOptions,
  ConnectorIngestResult,
  ConnectorRuntime,
  McpConnectorConfig,
} from "../types.js";

type McpConnectorInput = Pick<
  ConnectorDefinition,
  "description" | "displayName" | "id" | "requiredEnv"
>;

export function createMcpConnector(input: McpConnectorInput): ConnectorRuntime {
  const definition: ConnectorDefinition = {
    ...input,
    backend: "mcp-stdio",
    mode: "personal",
    supportsAgenticDiscovery: true,
  };

  return {
    ...definition,
    ingest: (options) => ingestMcpConnector(input.id, definition, options),
  };
}

async function ingestMcpConnector(
  connectorId: ConnectorId,
  definition: ConnectorDefinition,
  options?: ConnectorIngestOptions,
): Promise<ConnectorIngestResult> {
  const runId = createRunId();
  const state = await readConnectorState(connectorId);
  const config = await resolveMcpConnectorConfig(connectorId, options);
  const warnings: string[] = [];

  if (!config.enabled) {
    return {
      connectorId,
      message: `${definition.displayName} is not enabled. Configure ${openWikiConnectorsDisplayPath}/${connectorId}/config.json with an MCP transport.`,
      rawFiles: [],
      runId,
      statePath: `${openWikiConnectorsDisplayPath}/${connectorId}/state.json`,
      status: "skipped",
      warnings,
    };
  }

  if (!config.transport || !Array.isArray(config.readOnlyOperations)) {
    return await finishMcpRun({
      connectorId,
      message: "MCP config must include transport and readOnlyOperations.",
      rawFiles: [],
      runId,
      state,
      status: "error",
      warnings: ["MCP config must include transport and readOnlyOperations."],
    });
  }

  if (config.readOnlyOperations.length === 0) {
    const discovery = await listMcpTools(config);
    const rawFile = await writeRawJson(connectorId, runId, "mcp-tools.json", {
      connectorId,
      generatedAt: new Date().toISOString(),
      note: "No readOnlyOperations are configured. Use these discovered tools to choose read-only operations.",
      tools: discovery.tools,
      transport: sanitizeMcpTransport(config.transport),
    });

    return await finishMcpRun({
      connectorId,
      message: `Discovered ${discovery.tools.length} MCP tool(s). Use openwiki_call_mcp_tool for interactive ingestion or save readOnlyOperations as an optional automation recipe.`,
      rawFiles: [rawFile],
      runId,
      state,
      status: "skipped",
      warnings: [
        "No readOnlyOperations configured; listed available MCP tools instead of guessing.",
      ],
    });
  }

  const execution = await executeMcpReadOnlyOperations(config);
  // MCP reports a failed tool call (expired credentials, bad arguments) as a
  // normal result with isError, so keep it out of the dump and surface it.
  const operations = execution.operations.filter((operation) => {
    if (!isMcpToolError(operation.result)) return true;
    warnings.push(
      `${operation.name}: ${getMcpToolErrorText(operation.result)}`,
    );
    return false;
  });

  if (operations.length === 0) {
    return await finishMcpRun({
      connectorId,
      message: `All ${execution.operations.length} read-only MCP operation(s) failed.`,
      rawFiles: [],
      runId,
      state,
      status: "error",
      warnings,
    });
  }

  const rawFile = await writeRawJson(connectorId, runId, "mcp-results.json", {
    connectorId,
    generatedAt: new Date().toISOString(),
    mode: config.mode ?? "mcp-stdio",
    operations,
    readOnlyOperations: config.readOnlyOperations.map((operation) => ({
      args: operation.args,
      name: operation.name,
      type: operation.type,
    })),
    transport: sanitizeMcpTransport(config.transport),
  });

  return await finishMcpRun({
    connectorId,
    message: `Executed ${operations.length} read-only MCP operation(s).`,
    rawFiles: [rawFile],
    runId,
    state,
    status: "success",
    warnings,
  });
}

/**
 * Whether an MCP operation result is a tool execution error (`isError: true`).
 */
function isMcpToolError(result: unknown): result is { content?: unknown } {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { isError?: unknown }).isError === true
  );
}

/**
 * Joins the text content of a failed MCP tool result for a warning line.
 */
function getMcpToolErrorText(result: { content?: unknown }): string {
  const text = (Array.isArray(result.content) ? result.content : [])
    .map((item: unknown) =>
      typeof item === "object" &&
      item !== null &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string"
        ? (item as { text: string }).text
        : "",
    )
    .filter((value) => value.length > 0)
    .join(" ");

  return text || "MCP tool returned an error.";
}

/**
 * Disk config is the base; optional ingest `connectorConfig` (source-instance
 * override from onboarding) wins field-by-field without inventing defaults.
 */
async function resolveMcpConnectorConfig(
  connectorId: ConnectorId,
  options?: ConnectorIngestOptions,
): Promise<McpConnectorConfig> {
  const diskConfig = await readConnectorConfig<McpConnectorConfig>(
    connectorId,
    {
      enabled: false,
      readOnlyOperations: [],
    },
  );
  const override = options?.connectorConfig;
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return diskConfig;
  }

  return {
    ...diskConfig,
    ...(override as Partial<McpConnectorConfig>),
  };
}

async function finishMcpRun({
  connectorId,
  message,
  rawFiles,
  runId,
  state,
  status,
  warnings,
}: {
  connectorId: ConnectorId;
  message: string;
  rawFiles: string[];
  runId: string;
  state: Awaited<ReturnType<typeof readConnectorState>>;
  status: ConnectorIngestResult["status"];
  warnings: string[];
}): Promise<ConnectorIngestResult> {
  await writeConnectorState(
    connectorId,
    updateStateWithRun(state, {
      at: new Date().toISOString(),
      rawFiles,
      runId,
      status,
      warnings,
    }),
  );

  return {
    connectorId,
    message,
    rawFiles,
    runId,
    statePath: `${openWikiConnectorsDisplayPath}/${connectorId}/state.json`,
    status,
    warnings,
  };
}
