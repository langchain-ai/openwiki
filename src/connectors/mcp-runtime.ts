import {
  createRunId,
  readConnectorConfig,
  readConnectorState,
  updateStateWithRun,
  writeConnectorState,
  writeRawJson,
} from "./io.js";
import {
  executeMcpTool,
  listMcpTools,
  type McpToolDescriptor,
} from "./mcp-client.js";
import type {
  ConnectorId,
  ConnectorIngestResult,
  McpConnectorConfig,
} from "./types.js";
import { isSecretLikeKey } from "../diagnostics.js";

export type McpConnectorId = Extract<ConnectorId, "notion">;

export type McpToolDiscoveryResult = {
  connectorId: McpConnectorId;
  rawFile: string;
  runId: string;
  tools: McpToolDescriptor[];
};

export type McpToolCallResult = {
  allowedBy: string;
  connectorId: McpConnectorId;
  rawFile: string;
  result: unknown;
  runId: string;
  toolName: string;
};

const MCP_CONNECTOR_IDS = new Set<ConnectorId>(["notion"]);

export function isMcpConnectorId(
  connectorId: ConnectorId,
): connectorId is McpConnectorId {
  return MCP_CONNECTOR_IDS.has(connectorId);
}

export async function discoverMcpConnectorTools(
  connectorId: McpConnectorId,
): Promise<McpToolDiscoveryResult> {
  const runId = createRunId();
  const state = await readConnectorState(connectorId);
  const config = await readMcpConnectorConfig(connectorId);
  const discovery = await listMcpTools(config);
  const rawFile = await writeRawJson(connectorId, runId, "mcp-tools.json", {
    connectorId,
    generatedAt: new Date().toISOString(),
    note: "Live MCP tools/list discovery. Tool names must be used exactly as returned.",
    tools: discovery.tools,
    transport: sanitizeMcpTransport(config.transport),
  });

  await recordMcpRun(connectorId, state, {
    rawFiles: [rawFile],
    runId,
    status: "success",
    warnings: [],
  });

  return {
    connectorId,
    rawFile,
    runId,
    tools: discovery.tools,
  };
}

export async function callMcpConnectorTool(
  connectorId: McpConnectorId,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolCallResult> {
  const runId = createRunId();
  const state = await readConnectorState(connectorId);
  const config = await readMcpConnectorConfig(connectorId);
  const discovery = await listMcpTools(config);
  const tool = discovery.tools.find((candidate) => candidate.name === toolName);

  if (!tool) {
    throw new Error(
      `MCP tool ${toolName} was not returned by tools/list for ${connectorId}. Run openwiki_list_mcp_tools first and use an exact discovered name.`,
    );
  }

  const policy = getToolCallPolicy(connectorId, config, tool);
  if (!policy.allowed) {
    throw new Error(policy.reason);
  }

  const result = await executeMcpTool(config, tool.name, args);
  const rawFile = await writeRawJson(
    connectorId,
    runId,
    "mcp-tool-result.json",
    {
      args: sanitizeValue(args),
      connectorId,
      generatedAt: new Date().toISOString(),
      result,
      tool,
      toolName: tool.name,
      transport: sanitizeMcpTransport(config.transport),
    },
  );

  await recordMcpRun(connectorId, state, {
    rawFiles: [rawFile],
    runId,
    status: "success",
    warnings: [],
  });

  return {
    allowedBy: policy.reason,
    connectorId,
    rawFile,
    result,
    runId,
    toolName: tool.name,
  };
}

export function sanitizeMcpTransport(
  transport: McpConnectorConfig["transport"],
): McpConnectorConfig["transport"] | null {
  if (!transport) {
    return null;
  }

  return {
    args: transport.args,
    command: transport.command,
    env: transport.env,
    headers: transport.headers
      ? Object.fromEntries(
          Object.entries(transport.headers).map(([key, value]) => [
            key,
            value.replace(/\$\{?[A-Z_][A-Z0-9_]*\}?/gu, "<env-ref>"),
          ]),
        )
      : undefined,
    type: transport.type,
    url: transport.url,
  };
}

async function readMcpConnectorConfig(
  connectorId: McpConnectorId,
): Promise<McpConnectorConfig> {
  const config = await readConnectorConfig<McpConnectorConfig>(connectorId, {
    enabled: false,
    readOnlyOperations: [],
  });

  if (!config.enabled) {
    throw new Error(`${connectorId} MCP connector is not enabled.`);
  }

  if (!config.transport) {
    throw new Error(`${connectorId} MCP connector config requires transport.`);
  }

  return config;
}

async function recordMcpRun(
  connectorId: McpConnectorId,
  state: Awaited<ReturnType<typeof readConnectorState>>,
  run: {
    rawFiles: string[];
    runId: string;
    status: ConnectorIngestResult["status"];
    warnings: string[];
  },
): Promise<void> {
  await writeConnectorState(
    connectorId,
    updateStateWithRun(state, {
      at: new Date().toISOString(),
      rawFiles: run.rawFiles,
      runId: run.runId,
      status: run.status,
      warnings: run.warnings,
    }),
  );
}

function getToolCallPolicy(
  connectorId: McpConnectorId,
  config: McpConnectorConfig,
  tool: McpToolDescriptor,
): { allowed: true; reason: string } | { allowed: false; reason: string } {
  if (config.allowedTools?.includes(tool.name)) {
    return {
      allowed: true,
      reason: "allowed by connector config allowedTools",
    };
  }

  if (tool.annotations?.readOnlyHint === true) {
    return { allowed: true, reason: "allowed by MCP readOnlyHint annotation" };
  }

  if (
    connectorId === "notion" &&
    isHostedNotionTransport(config.transport) &&
    looksLikeReadOnlyNotionTool(tool)
  ) {
    return {
      allowed: true,
      reason: "allowed by hosted Notion read-only tool name/description",
    };
  }

  return {
    allowed: false,
    reason: `MCP tool ${tool.name} is not marked read-only. Add it to allowedTools in the local connector config only if it is safe for ingestion.`,
  };
}

function isHostedNotionTransport(
  transport: McpConnectorConfig["transport"],
): boolean {
  if (transport?.type !== "http" || !transport.url) {
    return false;
  }

  const url = new URL(transport.url);

  return (
    url.protocol === "https:" &&
    url.hostname === "mcp.notion.com" &&
    url.pathname.replace(/\/+$/u, "") === "/mcp"
  );
}

function looksLikeReadOnlyNotionTool(tool: McpToolDescriptor): boolean {
  const text = `${tool.name} ${tool.description ?? ""}`;
  const looksReadOnly =
    /\b(search|retrieve|get|list|query|read|fetch|find|lookup|load|children)\b/iu.test(
      text,
    );
  const looksMutating =
    /\b(create|update|delete|archive|restore|move|patch|insert|append|comment|invite|share|upload|write|edit|send|add|remove)\b/iu.test(
      text,
    );

  return looksReadOnly && !looksMutating;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        isSecretLikeKey(key) ? "<redacted>" : sanitizeValue(entry),
      ]),
    );
  }

  return value;
}
