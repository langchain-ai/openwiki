import {
  DynamicStructuredTool,
  type StructuredToolInterface,
} from "@langchain/core/tools";
import { constants as fsConstants } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  getConnectorConfigPath,
  getConnectorRawDir,
  openWikiHomeDir,
  openWikiLocalWikiDir,
  resolveConnectorRawPath,
} from "../openwiki-home.js";
import { createConnectorRegistry, isConnectorId } from "./registry.js";
import {
  callMcpConnectorTool,
  discoverMcpConnectorTools,
  isMcpConnectorId,
} from "./mcp-runtime.js";
import type { ConnectorId, ConnectorIngestOptions } from "./types.js";

export function createOpenWikiConnectorTools(): StructuredToolInterface[] {
  return [
    new DynamicStructuredTool({
      name: "openwiki_list_connectors",
      description:
        "List built-in OpenWiki connectors, their backends, required env var names, config paths, and raw data paths. Secret values are never returned.",
      schema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      } as const,
      func: async () => stringifyToolResult(await listConnectors()),
    }),
    new DynamicStructuredTool({
      name: "openwiki_list_mcp_tools",
      description:
        'List live MCP tools for a configured MCP connector and write discovery under ~/.openwiki/connectors/<id>/raw. Input: {"connectorId":"notion"}. Use exact returned tool names.',
      schema: {
        type: "object",
        properties: {
          connectorId: {
            type: "string",
            enum: ["notion"],
          },
        },
        required: ["connectorId"],
        additionalProperties: false,
      } as const,
      func: async (input) =>
        stringifyToolResult(
          await listMcpToolsForConnector(getConnectorId(input, "connectorId")),
        ),
    }),
    new DynamicStructuredTool({
      name: "openwiki_call_mcp_tool",
      description:
        'Call one exact discovered read-only MCP tool and write the result under ~/.openwiki/connectors/<id>/raw. Input: {"connectorId":"notion","toolName":"exact_tool_name","args":{"query":"Applied AI"}}.',
      schema: {
        type: "object",
        properties: {
          args: {
            type: "object",
            additionalProperties: true,
          },
          connectorId: {
            type: "string",
            enum: ["notion"],
          },
          toolName: {
            type: "string",
          },
        },
        required: ["connectorId", "toolName"],
        additionalProperties: false,
      } as const,
      func: async (input) =>
        stringifyToolResult(
          await callMcpToolForConnector(
            getConnectorId(input, "connectorId"),
            getStringInput(input, "toolName"),
            getRecordInput(input, "args") ?? {},
          ),
        ),
    }),
    new DynamicStructuredTool({
      name: "openwiki_ingest_connector",
      description:
        'Run deterministic ingestion for one built-in connector and write raw data/manifests under ~/.openwiki/connectors/<id>/raw. Input: {"connectorId":"x","streams":["bookmarks"],"limit":1}.',
      schema: {
        type: "object",
        properties: {
          connectorId: {
            type: "string",
            enum: [
              "git-repo",
              "google",
              "hackernews",
              "notion",
              "slack",
              "web-search",
              "x",
            ],
          },
          limit: { type: "number" },
          streams: {
            type: "array",
            items: { type: "string" },
          },
          windowHours: { type: "number" },
        },
        required: ["connectorId"],
        additionalProperties: false,
      } as const,
      func: async (input) =>
        stringifyToolResult(
          await ingestConnector(
            getConnectorId(input, "connectorId"),
            getIngestOptions(input),
          ),
        ),
    }),
    new DynamicStructuredTool({
      name: "openwiki_ingest_all_connectors",
      description:
        "Run deterministic ingestion for all configured built-in connectors. Connectors that are not configured or enabled are skipped.",
      schema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      } as const,
      func: async () => stringifyToolResult(await ingestAllConnectors()),
    }),
    new DynamicStructuredTool({
      name: "openwiki_list_raw_items",
      description:
        'List raw files for a connector under ~/.openwiki/connectors/<id>/raw. Input: {"connectorId":"x"}.',
      schema: {
        type: "object",
        properties: {
          connectorId: {
            type: "string",
            enum: [
              "git-repo",
              "google",
              "hackernews",
              "notion",
              "slack",
              "web-search",
              "x",
            ],
          },
        },
        required: ["connectorId"],
        additionalProperties: false,
      } as const,
      func: async (input) =>
        stringifyToolResult(
          await listRawItems(getConnectorId(input, "connectorId")),
        ),
    }),
    new DynamicStructuredTool({
      name: "openwiki_read_raw_item",
      description:
        'Read a raw connector file by connector ID and relative path. Only files inside ~/.openwiki/connectors/<id>/raw are allowed. Input: {"connectorId":"x","path":"2026-.../bookmarks.json","maxBytes":50000}.',
      schema: {
        type: "object",
        properties: {
          connectorId: {
            type: "string",
            enum: [
              "git-repo",
              "google",
              "hackernews",
              "notion",
              "slack",
              "web-search",
              "x",
            ],
          },
          maxBytes: {
            type: "number",
          },
          path: {
            type: "string",
          },
        },
        required: ["connectorId", "path"],
        additionalProperties: false,
      } as const,
      func: async (input) =>
        stringifyToolResult(
          await readRawItem(
            getConnectorId(input, "connectorId"),
            getStringInput(input, "path"),
            getNumberInput(input, "maxBytes") ?? 100_000,
          ),
        ),
    }),
  ];
}

async function listConnectors() {
  const registry = createConnectorRegistry();
  const connectors = [];

  for (const connector of Object.values(registry)) {
    const configPath = getConnectorConfigPath(connector.id);
    const configExists = await pathExists(configPath);
    const requiredEnvStatus = connector.requiredEnv.map((key) => ({
      key,
      set: Boolean(process.env[key]),
    }));
    const allRequiredEnvSet = requiredEnvStatus.every((env) => env.set);

    connectors.push({
      authConfigured: connector.requiredEnv.length === 0 || allRequiredEnvSet,
      backend: connector.backend,
      configExists,
      configPath,
      description: connector.description,
      displayName: connector.displayName,
      id: connector.id,
      rawDir: getConnectorRawDir(connector.id),
      readyForIngestion: configExists && allRequiredEnvSet,
      requiredEnv: connector.requiredEnv,
      requiredEnvStatus,
      supportsAgenticDiscovery: connector.supportsAgenticDiscovery,
    });
  }

  return {
    note: "Secret values are never returned. requiredEnvStatus reports presence only.",
    homeDir: openWikiHomeDir,
    wikiDir: openWikiLocalWikiDir,
    connectors,
  };
}

async function ingestConnector(
  connectorId: ConnectorId,
  options: ConnectorIngestOptions,
) {
  const registry = createConnectorRegistry();

  return registry[connectorId].ingest(options);
}

async function listMcpToolsForConnector(connectorId: ConnectorId) {
  if (!isMcpConnectorId(connectorId)) {
    throw new Error(`Connector ${connectorId} is not MCP-backed.`);
  }

  return await discoverMcpConnectorTools(connectorId);
}

async function callMcpToolForConnector(
  connectorId: ConnectorId,
  toolName: string,
  args: Record<string, unknown>,
) {
  if (!isMcpConnectorId(connectorId)) {
    throw new Error(`Connector ${connectorId} is not MCP-backed.`);
  }

  return await callMcpConnectorTool(connectorId, toolName, args);
}

async function ingestAllConnectors() {
  const registry = createConnectorRegistry();
  const results = [];

  for (const connector of Object.values(registry)) {
    results.push(await connector.ingest());
  }

  return {
    results,
  };
}

async function listRawItems(connectorId: ConnectorId) {
  const rawDir = getConnectorRawDir(connectorId);
  const files = await listFiles(rawDir, rawDir);
  const latestRunId = getLatestRunId(files);

  return {
    connectorId,
    files,
    latestFiles:
      latestRunId === null
        ? []
        : files.filter((file) => file.startsWith(`${latestRunId}/`)),
    latestRunId,
    note: "Files are sorted newest run first so agents should prefer latestFiles for current answers.",
    rawDir,
  };
}

async function readRawItem(
  connectorId: ConnectorId,
  relativePath: string,
  maxBytes: number,
) {
  const filePath = resolveConnectorRawPath(connectorId, relativePath);
  const fileHandle = await open(
    filePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );

  try {
    const fileStat = await fileHandle.stat();

    if (!fileStat.isFile()) {
      throw new Error("Raw item path must point to a file.");
    }

    const content = await fileHandle.readFile("utf8");
    const limit = Math.max(1, Math.min(maxBytes, 500_000));

    return {
      connectorId,
      content: content.slice(0, limit),
      filePath,
      truncated: content.length > limit,
    };
  } finally {
    await fileHandle.close();
  }
}

async function listFiles(
  rootDir: string,
  currentDir: string,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return [];
    }

    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listFiles(rootDir, entryPath)));
    } else if (entry.isFile()) {
      files.push(path.relative(rootDir, entryPath));
    }
  }

  return files.sort(compareRawFilePaths);
}

function compareRawFilePaths(left: string, right: string): number {
  const [leftRun = "", leftFile = ""] = left.split("/", 2);
  const [rightRun = "", rightFile = ""] = right.split("/", 2);

  if (leftRun !== rightRun) {
    return rightRun.localeCompare(leftRun);
  }

  return leftFile.localeCompare(rightFile);
}

function getLatestRunId(files: string[]): string | null {
  const firstFile = files[0];
  if (!firstFile) {
    return null;
  }

  return firstFile.split("/", 1)[0] ?? null;
}

function getConnectorId(input: unknown, key: string): ConnectorId {
  const value = getStringInput(input, key);

  if (!isConnectorId(value)) {
    throw new Error(`Invalid connector ID: ${value}`);
  }

  return value;
}

function getIngestOptions(input: unknown): ConnectorIngestOptions {
  return {
    limit: getNumberInput(input, "limit") ?? undefined,
    streams: getStringArrayInput(input, "streams"),
    windowHours: getNumberInput(input, "windowHours") ?? undefined,
  };
}

function getStringInput(input: unknown, key: string): string {
  if (!isRecord(input) || typeof input[key] !== "string") {
    throw new Error(`Missing string input: ${key}`);
  }

  return input[key];
}

function getNumberInput(input: unknown, key: string): number | null {
  if (!isRecord(input) || input[key] === undefined) {
    return null;
  }

  if (typeof input[key] !== "number") {
    throw new Error(`Expected number input: ${key}`);
  }

  return input[key];
}

function getRecordInput(
  input: unknown,
  key: string,
): Record<string, unknown> | null {
  if (!isRecord(input) || input[key] === undefined) {
    return null;
  }

  if (!isRecord(input[key])) {
    throw new Error(`Expected object input: ${key}`);
  }

  return input[key];
}

function getStringArrayInput(
  input: unknown,
  key: string,
): string[] | undefined {
  if (!isRecord(input) || input[key] === undefined) {
    return undefined;
  }

  if (!Array.isArray(input[key])) {
    throw new Error(`Expected string array input: ${key}`);
  }

  return input[key].filter(
    (value): value is string => typeof value === "string",
  );
}

function stringifyToolResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}
