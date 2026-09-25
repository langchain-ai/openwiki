import { createGitRepoConnector } from "./sources/git-repo.js";
import { createGmailConnector } from "./sources/gmail.js";
import { createHackerNewsConnector } from "./sources/hackernews.js";
import { createLangSmithConnector } from "./sources/langsmith/index.js";
import { createMcpConnector } from "./sources/mcp.js";
import { createSlackConnector } from "./sources/slack.js";
import { createWebSearchConnector } from "./sources/web-search.js";
import { createXConnector } from "./sources/x.js";
import { openWikiConnectorsDisplayPath } from "../config/openwiki-home.js";
import type { ConnectorId, ConnectorRuntime } from "./types.js";

export const CONNECTOR_IDS = [
  "custom-mcp",
  "git-repo",
  "notion",
  "x",
  "google",
  "web-search",
  "hackernews",
  "langsmith",
  "slack",
] as const satisfies readonly ConnectorId[];

export function createConnectorRegistry(): Record<
  ConnectorId,
  ConnectorRuntime
> {
  return {
    "custom-mcp": createMcpConnector({
      description: `Generic read-only MCP knowledge source. Point OpenWiki at any MCP server via ${openWikiConnectorsDisplayPath}/custom-mcp/config.json (HTTP or stdio transport). Prefer allowedTools and/or MCP readOnlyHint; do not guess mutating tools.`,
      displayName: "Custom MCP",
      id: "custom-mcp",
      // Secrets are referenced by env var name in transport.headers / transport.env.
      // Different MCP servers need different credentials, so none are hard-required.
      requiredEnv: [],
    }),
    "git-repo": createGitRepoConnector(),
    google: createGmailConnector(),
    hackernews: createHackerNewsConnector(),
    langsmith: createLangSmithConnector(),
    notion: createMcpConnector({
      description:
        "Notion connector backed by the hosted Notion MCP server or another configured read-only MCP server.",
      displayName: "Notion",
      id: "notion",
      requiredEnv: ["OPENWIKI_NOTION_MCP_ACCESS_TOKEN"],
    }),
    slack: createSlackConnector(),
    "web-search": createWebSearchConnector(),
    x: createXConnector(),
  };
}

export function isConnectorId(value: string): value is ConnectorId {
  return (CONNECTOR_IDS as readonly string[]).includes(value);
}

/**
 * Connector ids that require auth and have all required env vars set. Used by
 * telemetry as an adoption signal.
 */
export function getConfiguredConnectorIds(): ConnectorId[] {
  const registry = createConnectorRegistry();

  return Object.values(registry)
    .filter(
      (connector) =>
        connector.requiredEnv.length > 0 &&
        connector.requiredEnv.every((key) => Boolean(process.env[key])),
    )
    .map((connector) => connector.id);
}
