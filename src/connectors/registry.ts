import { createGitRepoConnector } from "./sources/git-repo.js";
import { createGmailConnector } from "./sources/gmail.js";
import { createHackerNewsConnector } from "./sources/hackernews.js";
import { createMcpConnector } from "./sources/mcp.js";
import { createSlackConnector } from "./sources/slack.js";
import { createWebSearchConnector } from "./sources/web-search.js";
import { createXConnector } from "./sources/x.js";
import type { ConnectorId, ConnectorRuntime } from "./types.js";

export const CONNECTOR_IDS = [
  "git-repo",
  "notion",
  "x",
  "google",
  "web-search",
  "hackernews",
  "slack",
] as const satisfies readonly ConnectorId[];

export function createConnectorRegistry(): Record<
  ConnectorId,
  ConnectorRuntime
> {
  return {
    "git-repo": createGitRepoConnector(),
    google: createGmailConnector(),
    hackernews: createHackerNewsConnector(),
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
