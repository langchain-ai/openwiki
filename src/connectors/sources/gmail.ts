import {
  OPENWIKI_GMAIL_ACCESS_TOKEN_ENV_KEY,
  OPENWIKI_GMAIL_REFRESH_TOKEN_ENV_KEY,
} from "../../constants.js";
import {
  getOAuthAccessToken,
  refreshOAuthAccessToken,
} from "../../auth/tokens.js";
import {
  createRunId,
  readConnectorConfig,
  readConnectorState,
  updateStateWithRun,
  writeConnectorState,
  writeRawJson,
} from "../io.js";
import type {
  ConnectorDefinition,
  ConnectorIngestOptions,
  ConnectorIngestResult,
  ConnectorRuntime,
} from "../types.js";

type GmailConfig = {
  enabled?: boolean;
  format?: GmailMessageFormat;
  includeSpamTrash?: boolean;
  labelIds?: string[];
  maxMessages?: number;
  metadataHeaders?: string[];
  pageSize?: number;
  query?: string;
  readOnlyOperations?: unknown[];
  transport?: unknown;
};

type GmailMessageFormat = "full" | "metadata" | "minimal";

type GmailListResponse = {
  messages?: GmailMessageRef[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
};

type GmailMessageRef = {
  id?: string;
  threadId?: string;
};

const GMAIL_API_BASE_URL = "https://gmail.googleapis.com/gmail/v1";

const DEFAULT_METADATA_HEADERS = [
  "From",
  "To",
  "Cc",
  "Bcc",
  "Subject",
  "Date",
  "Message-ID",
];

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Fetches recent Gmail messages through the Gmail API with OAuth user credentials.",
  displayName: "Google / Gmail",
  id: "google",
  requiredEnv: [
    OPENWIKI_GMAIL_ACCESS_TOKEN_ENV_KEY,
    OPENWIKI_GMAIL_REFRESH_TOKEN_ENV_KEY,
  ],
  supportsAgenticDiscovery: false,
};

export function createGmailConnector(): ConnectorRuntime {
  return {
    ...definition,
    ingest,
  };
}

async function ingest(
  options: ConnectorIngestOptions = {},
): Promise<ConnectorIngestResult> {
  const runId = createRunId();
  const config = await readConnectorConfig<GmailConfig>("google", {
    enabled: true,
    format: "full",
    includeSpamTrash: false,
    labelIds: [],
    maxMessages: 100,
    metadataHeaders: DEFAULT_METADATA_HEADERS,
    pageSize: 100,
    query: "newer_than:1d",
  });
  const state = await readConnectorState("google");
  const warnings: string[] = [];
  const rawFiles: string[] = [];

  if (!isGmailEnabled(config)) {
    return {
      connectorId: "google",
      message:
        "Google / Gmail connector is not enabled. Set enabled=true in ~/.openwiki/connectors/google/config.json.",
      rawFiles,
      runId,
      statePath: "~/.openwiki/connectors/google/state.json",
      status: "skipped",
      warnings,
    };
  }

  if (isLegacyMcpGmailConfig(config)) {
    warnings.push(
      "Ignoring legacy Gmail MCP placeholder config; direct Gmail API ingestion is enabled by default.",
    );
  }

  const accessToken = await getOAuthAccessToken("gmail");
  const messageLimit = getOptionLimit(options.limit, config.maxMessages);
  const query = getWindowedGmailQuery(config.query, options.windowHours);
  const listResult = await listGmailMessages(accessToken, {
    includeSpamTrash: config.includeSpamTrash,
    labelIds: config.labelIds,
    maxMessages: messageLimit,
    pageSize: config.pageSize,
    query,
  });
  const format = normalizeGmailFormat(config.format);
  const messages = [];

  for (const message of listResult.messageRefs) {
    if (!message.id) {
      continue;
    }

    messages.push(
      await getGmailMessage(accessToken, message.id, {
        format,
        metadataHeaders: config.metadataHeaders,
      }),
    );
  }

  rawFiles.push(
    await writeRawJson("google", runId, "gmail-messages.json", {
      fetchedAt: new Date().toISOString(),
      format,
      includeSpamTrash: Boolean(config.includeSpamTrash),
      labelIds: normalizeStringArray(config.labelIds),
      listPages: listResult.pages,
      maxMessages: messageLimit,
      messageCount: messages.length,
      messages,
      query,
      windowHours: normalizeWindowHours(options.windowHours),
    }),
  );

  await writeConnectorState(
    "google",
    updateStateWithRun(state, {
      at: new Date().toISOString(),
      rawFiles,
      runId,
      status: rawFiles.length > 0 ? "success" : "skipped",
      warnings,
    }),
  );

  return {
    connectorId: "google",
    message: `Fetched ${messages.length} Gmail message(s).`,
    rawFiles,
    runId,
    statePath: "~/.openwiki/connectors/google/state.json",
    status: rawFiles.length > 0 ? "success" : "skipped",
    warnings,
  };
}

async function listGmailMessages(
  accessToken: string,
  options: {
    includeSpamTrash?: boolean;
    labelIds?: string[];
    maxMessages: number;
    pageSize?: number;
    query?: string;
  },
): Promise<{
  messageRefs: GmailMessageRef[];
  pages: {
    messageCount: number;
    resultSizeEstimate?: number;
  }[];
}> {
  const messageRefs: GmailMessageRef[] = [];
  const pages = [];
  let pageToken: string | undefined;

  while (messageRefs.length < options.maxMessages) {
    const pageSize = Math.min(
      clamp(options.pageSize, 1, 500),
      options.maxMessages - messageRefs.length,
    );
    const page = await gmailApi<GmailListResponse>(
      accessToken,
      "/users/me/messages",
      {
        includeSpamTrash: String(Boolean(options.includeSpamTrash)),
        maxResults: String(pageSize),
        pageToken,
        q: getGmailQuery(options.query),
      },
      normalizeStringArray(options.labelIds).map((labelId) => [
        "labelIds",
        labelId,
      ]),
    );
    const pageMessages = page.messages ?? [];

    messageRefs.push(...pageMessages);
    pages.push({
      messageCount: pageMessages.length,
      resultSizeEstimate: page.resultSizeEstimate,
    });

    pageToken = page.nextPageToken;
    if (!pageToken || pageMessages.length === 0) {
      break;
    }
  }

  return {
    messageRefs: messageRefs.slice(0, options.maxMessages),
    pages,
  };
}

async function getGmailMessage(
  accessToken: string,
  messageId: string,
  options: {
    format: GmailMessageFormat;
    metadataHeaders?: string[];
  },
): Promise<unknown> {
  return await gmailApi(
    accessToken,
    `/users/me/messages/${encodeURIComponent(messageId)}`,
    {
      format: options.format,
    },
    options.format === "metadata"
      ? normalizeStringArray(options.metadataHeaders).map((header) => [
          "metadataHeaders",
          header,
        ])
      : [],
  );
}

async function gmailApi<T>(
  accessToken: string,
  endpointPath: string,
  params: Record<string, string | undefined>,
  repeatedParams: [string, string][] = [],
): Promise<T> {
  const response = await fetchGmail(
    accessToken,
    endpointPath,
    params,
    repeatedParams,
  );

  if (response.status !== 401) {
    return (await parseGmailResponse(response)) as T;
  }

  const refreshedToken = await refreshOAuthAccessToken("gmail");
  const retryResponse = await fetchGmail(
    refreshedToken,
    endpointPath,
    params,
    repeatedParams,
  );

  return (await parseGmailResponse(retryResponse)) as T;
}

async function fetchGmail(
  accessToken: string,
  endpointPath: string,
  params: Record<string, string | undefined>,
  repeatedParams: [string, string][],
): Promise<Response> {
  const url = new URL(`${GMAIL_API_BASE_URL}${endpointPath}`);
  for (const [key, value] of Object.entries(removeEmptyValues(params))) {
    url.searchParams.set(key, value);
  }
  for (const [key, value] of repeatedParams) {
    url.searchParams.append(key, value);
  }

  return await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
}

async function parseGmailResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error(
      `Gmail API request failed: ${response.status} ${response.statusText}`,
    );
  }

  return await response.json();
}

function isGmailEnabled(config: GmailConfig): boolean {
  if (isLegacyMcpGmailConfig(config)) {
    return true;
  }

  return config.enabled !== false;
}

function isLegacyMcpGmailConfig(config: GmailConfig): boolean {
  return (
    config.transport !== undefined || config.readOnlyOperations !== undefined
  );
}

function getGmailQuery(query: string | undefined): string {
  const normalized = query?.trim();

  return normalized && normalized.length > 0 ? normalized : "newer_than:1d";
}

function getWindowedGmailQuery(
  query: string | undefined,
  windowHours: number | undefined,
): string {
  const normalizedQuery = getGmailQuery(query);
  const hours = normalizeWindowHours(windowHours);

  if (hours === null) {
    return normalizedQuery;
  }

  const windowQuery = `newer_than:${Math.max(1, Math.ceil(hours / 24))}d`;
  const baseQuery = stripGmailDateOperators(normalizedQuery);

  return baseQuery.length > 0 ? `${baseQuery} ${windowQuery}` : windowQuery;
}

function stripGmailDateOperators(query: string): string {
  return query
    .split(/\s+/u)
    .filter(
      (token) =>
        !/^(?:newer_than|older_than|newer|older|after|before):.+/iu.test(token),
    )
    .join(" ")
    .trim();
}

function normalizeWindowHours(windowHours: number | undefined): number | null {
  if (typeof windowHours !== "number" || !Number.isFinite(windowHours)) {
    return null;
  }

  return Math.max(1, Math.min(168, Math.trunc(windowHours)));
}

function normalizeGmailFormat(
  format: GmailConfig["format"],
): GmailMessageFormat {
  return ["full", "metadata", "minimal"].includes(format ?? "")
    ? (format as GmailMessageFormat)
    : "full";
}

function getOptionLimit(
  optionLimit: number | undefined,
  configLimit: number | undefined,
): number {
  return clamp(optionLimit ?? configLimit, 1, 500);
}

function clamp(value: number | undefined, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, Math.trunc(value ?? min)));
}

function normalizeStringArray(values: string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function removeEmptyValues(
  values: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[1].length > 0,
    ),
  );
}
