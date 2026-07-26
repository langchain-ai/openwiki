import { chmod, readFile, writeFile } from "node:fs/promises";
import { OPENWIKI_NOTION_MCP_ACCESS_TOKEN_ENV_KEY } from "../constants.js";
import {
  ensureConnectorHome,
  getConnectorConfigPath,
} from "../openwiki-home.js";
import {
  discoverMcpConnectorTools,
  isMcpConnectorId,
} from "../connectors/mcp-runtime.js";
import type { ConnectorId } from "../connectors/types.js";
import type { AuthProviderId } from "./types.js";

export type AuthConfigureResult = {
  configPath: string;
  nextSteps: string[];
  provider: AuthProviderId;
  status: "created" | "exists" | "updated";
};

export type AuthToolListResult = {
  configPath: string;
  provider: AuthProviderId;
  rawFile: string;
  tools: Awaited<ReturnType<typeof discoverMcpConnectorTools>>["tools"];
};

export async function configureAuthProvider(
  provider: AuthProviderId,
  options: { force?: boolean } = {},
): Promise<AuthConfigureResult> {
  const connectorId = getConnectorIdForProvider(provider);
  await ensureConnectorHome(connectorId);
  const configPath = getConnectorConfigPath(connectorId);
  const existing = await readExistingConfig(configPath);

  if (existing !== null && options.force !== true) {
    return {
      configPath,
      nextSteps: getNextSteps(provider, false),
      provider,
      status: "exists",
    };
  }

  await writeFile(
    configPath,
    `${JSON.stringify(getDefaultConfig(provider), null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  await chmod(configPath, 0o600);

  return {
    configPath,
    nextSteps: getNextSteps(provider, true),
    provider,
    status: existing === null ? "created" : "updated",
  };
}

export async function listAuthProviderTools(
  provider: AuthProviderId,
): Promise<AuthToolListResult> {
  const connectorId = getConnectorIdForProvider(provider);
  await ensureConnectorHome(connectorId);
  const configPath = getConnectorConfigPath(connectorId);
  const existing = await readExistingConfig(configPath);

  if (existing === null) {
    throw new Error(
      `Connector config does not exist. Run openwiki auth ${provider} first.`,
    );
  }

  if (!isMcpConnectorId(connectorId)) {
    throw new Error(`${provider} does not expose MCP tools.`);
  }

  const result = await discoverMcpConnectorTools(connectorId);

  return {
    configPath,
    provider,
    rawFile: result.rawFile,
    tools: result.tools,
  };
}

export function shouldDiscoverToolsAfterAuth(
  provider: AuthProviderId,
): boolean {
  return isMcpConnectorId(getConnectorIdForProvider(provider));
}

function getConnectorIdForProvider(provider: AuthProviderId): ConnectorId {
  return provider === "gmail" ? "google" : provider;
}

function getDefaultConfig(provider: AuthProviderId): unknown {
  if (provider === "notion") {
    return {
      enabled: true,
      readOnlyOperations: [],
      transport: {
        headers: {
          Authorization: `Bearer \${${OPENWIKI_NOTION_MCP_ACCESS_TOKEN_ENV_KEY}}`,
        },
        type: "http",
        url: "https://mcp.notion.com/mcp",
      },
    };
  }

  if (provider === "slack") {
    return {
      assistantSearchQueries: [],
      conversationScanLimit: 500,
      conversationTypes: ["public_channel", "private_channel", "im", "mpim"],
      enabled: true,
      maxConversations: 50,
      messagesPerConversation: 50,
      myMessagesSearchLimit: 20,
      streams: ["my_messages_search", "recent_messages"],
    };
  }

  if (provider === "gmail") {
    return {
      enabled: true,
      format: "full",
      includeSpamTrash: false,
      labelIds: [],
      maxMessages: 100,
      metadataHeaders: [
        "From",
        "To",
        "Cc",
        "Bcc",
        "Subject",
        "Date",
        "Message-ID",
      ],
      note: "Direct Gmail API ingestion. Tokens stay in ~/.openwiki/.env. query defaults to the last day of mail.",
      pageSize: 100,
      provider: "gmail",
      query: "newer_than:1d",
    };
  }

  return {
    enabled: true,
    listIds: [],
    maxPagesPerStream: 2,
    streams: [
      "home_timeline",
      "user_posts",
      "mentions",
      "bookmarks",
      "list_posts",
    ],
  };
}

function getNextSteps(
  provider: AuthProviderId,
  wroteConfig: boolean,
): string[] {
  const prefix = wroteConfig
    ? "Review the generated connector config."
    : "Existing connector config was preserved; pass --force to overwrite it.";

  if (provider === "notion") {
    return [
      prefix,
      "Run openwiki personal --update and the agent can discover and call read-only Notion MCP tools automatically.",
      "Use openwiki auth tools notion only when you want to inspect the live MCP tool list yourself.",
    ];
  }

  if (provider === "slack") {
    return [
      prefix,
      "Slack direct API ingestion is enabled by default for self-message search and recent messages.",
      "Add assistantSearchQueries and the assistant_search stream when you want Slack assistant search ingestion.",
    ];
  }

  if (provider === "gmail") {
    return [
      prefix,
      "Gmail direct API ingestion is enabled by default for the last day of mail.",
      "Adjust query/maxMessages/format if you want a different ingestion window or payload size.",
    ];
  }

  return [
    prefix,
    "Edit listIds if you want X list ingestion.",
    "Run openwiki personal --update after auth and config are complete.",
  ];
}

async function readExistingConfig(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return null;
    }

    throw error;
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
