import { OPENWIKI_SLACK_USER_TOKEN_ENV_KEY } from "../../constants.js";
import { getOAuthAccessToken } from "../../auth/tokens.js";
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

type SlackConfig = {
  assistantSearchQueries?: string[];
  conversationScanLimit?: number;
  conversationTypes?: SlackConversationType[];
  enabled?: boolean;
  maxConversations?: number;
  myMessagesSearchLimit?: number;
  messagesPerConversation?: number;
  streams?: SlackStream[];
};

type SlackStream =
  "assistant_search" | "my_messages_search" | "recent_messages";

type SlackConversationType =
  "im" | "mpim" | "private_channel" | "public_channel";

type SlackApiResponse = {
  channels?: SlackConversation[];
  error?: string;
  has_more?: boolean;
  messages?: SlackMessage[] | SlackSearchMessages;
  needed?: string;
  ok?: boolean;
  response_metadata?: {
    next_cursor?: string;
  };
  results?: unknown[];
  team?: string;
  team_id?: string;
  url?: string;
  user?: SlackUser;
  user_id?: string;
};

type SlackConversation = {
  id?: string;
  is_archived?: boolean;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  name?: string;
  updated?: number;
  user?: string;
};

type SlackMessage = {
  channel?: SlackSearchMessageChannel;
  permalink?: string;
  text?: string;
  ts?: string;
  type?: string;
  user?: string;
  username?: string;
};

type SlackSearchMessages = {
  matches?: SlackSearchMessage[];
  pagination?: {
    first?: number;
    last?: number;
    page?: number;
    page_count?: number;
    per_page?: number;
    total_count?: number;
  };
  paging?: {
    count?: number;
    page?: number;
    pages?: number;
    total?: number;
  };
  total?: number;
};

type SlackSearchMessage = SlackMessage & {
  channel?: SlackSearchMessageChannel;
};

type SlackSearchMessageChannel = {
  id?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  name?: string;
};

type SlackUser = {
  deleted?: boolean;
  id?: string;
  is_bot?: boolean;
  name?: string;
  profile?: {
    display_name?: string;
    real_name?: string;
    team?: string;
  };
  real_name?: string;
  team_id?: string;
};

type SlackUserMessage = {
  conversation: Pick<SlackConversation, "id" | "is_im" | "is_mpim" | "name">;
  message: SlackMessage;
};

const SLACK_API_BASE_URL = "https://slack.com/api";
const DEFAULT_STREAMS: SlackStream[] = [
  "my_messages_search",
  "recent_messages",
];
const DEFAULT_CONVERSATION_TYPES: SlackConversationType[] = [
  "public_channel",
  "private_channel",
  "im",
  "mpim",
];

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Fetches Slack conversations, recent messages, and assistant search context with a Slack user token.",
  displayName: "Slack",
  id: "slack",
  requiredEnv: [OPENWIKI_SLACK_USER_TOKEN_ENV_KEY],
  supportsAgenticDiscovery: false,
};

export function createSlackConnector(): ConnectorRuntime {
  return {
    ...definition,
    ingest,
  };
}

async function ingest(
  options: ConnectorIngestOptions = {},
): Promise<ConnectorIngestResult> {
  const runId = createRunId();
  const config = await readConnectorConfig<SlackConfig>("slack", {
    assistantSearchQueries: [],
    conversationScanLimit: 500,
    conversationTypes: DEFAULT_CONVERSATION_TYPES,
    enabled: false,
    maxConversations: 50,
    messagesPerConversation: 50,
    myMessagesSearchLimit: 20,
    streams: DEFAULT_STREAMS,
  });
  const state = await readConnectorState("slack");
  const warnings: string[] = [];
  const rawFiles: string[] = [];

  if (!config.enabled) {
    return {
      connectorId: "slack",
      message:
        "Slack connector is not enabled. Run openwiki auth configure slack --force to generate the direct Slack API config.",
      rawFiles,
      runId,
      statePath: "~/.openwiki/connectors/slack/state.json",
      status: "skipped",
      warnings,
    };
  }

  if (!process.env[OPENWIKI_SLACK_USER_TOKEN_ENV_KEY]) {
    return {
      connectorId: "slack",
      message: `${OPENWIKI_SLACK_USER_TOKEN_ENV_KEY} is required for Slack ingestion.`,
      rawFiles,
      runId,
      statePath: "~/.openwiki/connectors/slack/state.json",
      status: "error",
      warnings,
    };
  }

  const accessToken = await getOAuthAccessToken("slack");
  const streams = normalizeStreams(options.streams, config.streams);
  const auth = await slackApi(accessToken, "auth.test", {});
  const userId = typeof auth.user_id === "string" ? auth.user_id : undefined;
  const user = userId ? await fetchSlackUser(accessToken, userId) : undefined;
  let recent: Awaited<ReturnType<typeof fetchRecentMessages>> | undefined;
  let myMessagesSearch:
    Awaited<ReturnType<typeof fetchMyMessagesSearch>> | undefined;
  let myMessagesSearchError: string | undefined;

  rawFiles.push(
    await writeRawJson("slack", runId, "identity.json", {
      fetchedAt: new Date().toISOString(),
      team: auth.team,
      teamId: auth.team_id,
      teamUrl: auth.url,
      user,
      userId,
    }),
  );

  if (streams.includes("my_messages_search")) {
    if (userId) {
      try {
        myMessagesSearch = await fetchMyMessagesSearch(
          accessToken,
          userId,
          config,
        );
        rawFiles.push(
          await writeRawJson("slack", runId, "my-messages-search.json", {
            coverage: myMessagesSearch.coverage,
            fetchedAt: new Date().toISOString(),
            latestMessage: myMessagesSearch.userMessages[0] ?? null,
            user,
            userId,
            userMessages: myMessagesSearch.userMessages,
          }),
        );
      } catch (error) {
        myMessagesSearchError = formatError(error);
        warnings.push(
          `Slack self-message search failed; falling back to bounded conversation history. ${myMessagesSearchError}`,
        );
      }
    } else {
      warnings.push(
        "Slack self-message search was skipped because auth.test did not return a user_id.",
      );
    }
  }

  if (streams.includes("recent_messages")) {
    recent = await fetchRecentMessages(accessToken, config, userId);
    if (recent.userMessages.length <= 1) {
      warnings.push(
        "Slack found one or fewer authenticated-user messages in the bounded recent history window; latestMessage may not be the user's true latest Slack message.",
      );
    }
    rawFiles.push(
      await writeRawJson("slack", runId, "recent-messages.json", {
        coverage: recent.coverage,
        fetchedAt: new Date().toISOString(),
        userId,
        conversations: recent.conversations,
        userMessages: recent.userMessages,
      }),
    );
  }

  if (myMessagesSearch || recent) {
    const latestSource =
      myMessagesSearch && myMessagesSearch.userMessages.length > 0
        ? "search.messages"
        : "conversations.history";
    const latestMessages =
      latestSource === "search.messages"
        ? (myMessagesSearch?.userMessages ?? [])
        : (recent?.userMessages ?? []);

    rawFiles.push(
      await writeRawJson("slack", runId, "my-recent-messages.json", {
        coverage: {
          definitiveForLatestMessage: latestSource === "search.messages",
          latestMessageSource: latestSource,
          recent: recent?.coverage,
          search: myMessagesSearch?.coverage,
          searchError: myMessagesSearchError,
        },
        definitiveForLatestMessage: latestSource === "search.messages",
        fetchedAt: new Date().toISOString(),
        latestMessage: latestMessages[0] ?? null,
        note:
          latestSource === "search.messages"
            ? "latestMessage is computed from Slack search.messages sorted by timestamp descending for the authenticated user."
            : "latestMessage is only the latest authenticated-user message found in bounded conversations.history fallback data. It is not a reliable global answer for the user's true latest Slack message. Add the Slack user-token search:read scope and rerun openwiki auth slack to enable definitive self-message search.",
        recentUserMessages: recent?.userMessages ?? [],
        searchUserMessages: myMessagesSearch?.userMessages ?? [],
        source: latestSource,
        user,
        userId,
        userMessages: latestMessages,
      }),
    );
  }

  if (streams.includes("assistant_search")) {
    const searches = [];
    for (const query of config.assistantSearchQueries ?? []) {
      if (query.trim().length === 0) {
        continue;
      }

      searches.push({
        query,
        result: await slackApi(accessToken, "assistant.search.context", {
          query,
        }),
      });
    }

    if (searches.length > 0) {
      rawFiles.push(
        await writeRawJson("slack", runId, "assistant-search.json", {
          fetchedAt: new Date().toISOString(),
          searches,
          userId,
        }),
      );
    } else {
      warnings.push(
        "assistant_search requested but assistantSearchQueries is empty.",
      );
    }
  }

  await writeConnectorState(
    "slack",
    updateStateWithRun(state, {
      at: new Date().toISOString(),
      rawFiles,
      runId,
      status: rawFiles.length > 0 ? "success" : "skipped",
      warnings,
    }),
  );

  return {
    connectorId: "slack",
    message: `Fetched ${rawFiles.length} Slack dump(s).`,
    rawFiles,
    runId,
    statePath: "~/.openwiki/connectors/slack/state.json",
    status: rawFiles.length > 0 ? "success" : "skipped",
    warnings,
  };
}

async function fetchRecentMessages(
  accessToken: string,
  config: SlackConfig,
  userId: string | undefined,
): Promise<{
  coverage: ReturnType<typeof getRecentMessageCoverage>;
  conversations: {
    conversation: SlackConversation;
    messages: SlackMessage[];
    userMessages: SlackMessage[];
  }[];
  userMessages: SlackUserMessage[];
}> {
  const { conversations, scan } = await fetchConversations(accessToken, config);
  const messagesPerConversation = clamp(config.messagesPerConversation, 1, 100);
  const results = [];
  const userMessages: SlackUserMessage[] = [];

  for (const conversation of conversations) {
    if (!conversation.id) {
      continue;
    }

    const history = await slackApi(accessToken, "conversations.history", {
      channel: conversation.id,
      limit: String(messagesPerConversation),
    });
    const messages = getHistoryMessages(history);
    const matchingUserMessages = userId
      ? messages.filter((message) => message.user === userId)
      : [];
    for (const message of matchingUserMessages) {
      userMessages.push({
        conversation: {
          id: conversation.id,
          is_im: conversation.is_im,
          is_mpim: conversation.is_mpim,
          name: conversation.name,
        },
        message,
      });
    }

    results.push({
      conversation,
      messages,
      userMessages: matchingUserMessages,
    });
  }

  return {
    coverage: getRecentMessageCoverage(config, scan),
    conversations: results,
    userMessages: userMessages.sort(compareSlackUserMessages),
  };
}

async function fetchMyMessagesSearch(
  accessToken: string,
  userId: string,
  config: SlackConfig,
): Promise<{
  coverage: {
    limit: number;
    note: string;
    query: string;
    resultCount: number;
    source: "search.messages";
    sort: "timestamp_desc";
    total?: number;
  };
  userMessages: SlackUserMessage[];
}> {
  const limit = clamp(config.myMessagesSearchLimit, 1, 100);
  const query = `from:<@${sanitizeSlackUserId(userId)}>`;
  const response = await slackApi(accessToken, "search.messages", {
    count: String(limit),
    highlight: "false",
    query,
    sort: "timestamp",
    sort_dir: "desc",
  });
  const messages = getSearchMessages(response);
  const userMessages = messages
    .map((message) => ({
      conversation: {
        id: message.channel?.id,
        is_im: message.channel?.is_im,
        is_mpim: message.channel?.is_mpim,
        name: message.channel?.name,
      },
      message,
    }))
    .sort(compareSlackUserMessages);

  return {
    coverage: {
      limit,
      note: "Slack search.messages query for the authenticated user's messages, sorted by timestamp descending.",
      query,
      resultCount: userMessages.length,
      source: "search.messages",
      sort: "timestamp_desc",
      total: getSearchTotal(response),
    },
    userMessages,
  };
}

async function fetchSlackUser(
  accessToken: string,
  userId: string,
): Promise<SlackUser | undefined> {
  try {
    const response = await slackApi(accessToken, "users.info", {
      user: userId,
    });

    return response.user;
  } catch {
    return undefined;
  }
}

async function fetchConversations(
  accessToken: string,
  config: SlackConfig,
): Promise<{
  conversations: SlackConversation[];
  scan: SlackConversationScan;
}> {
  const maxConversations = clamp(config.maxConversations, 1, 500);
  const conversationScanLimit = clamp(config.conversationScanLimit, 1, 1000);
  const types = normalizeConversationTypes(config.conversationTypes).join(",");
  const conversations: SlackConversation[] = [];
  let cursor: string | undefined;

  while (conversations.length < conversationScanLimit) {
    const response = await slackApi(accessToken, "conversations.list", {
      cursor,
      exclude_archived: "true",
      limit: String(
        Math.min(200, conversationScanLimit - conversations.length),
      ),
      types,
    });

    conversations.push(
      ...(response.channels ?? []).filter(
        (conversation) => conversation.id && !conversation.is_archived,
      ),
    );
    cursor = response.response_metadata?.next_cursor;

    if (!cursor) {
      break;
    }
  }

  const sortedConversations = dedupeConversations(conversations).sort(
    compareSlackConversationsByUpdated,
  );
  const selectedConversations = sortedConversations.slice(0, maxConversations);

  return {
    conversations: selectedConversations,
    scan: {
      conversationScanLimit,
      hasMoreAfterScan: Boolean(cursor),
      maxConversations,
      scannedConversationCount: sortedConversations.length,
      selectedConversationCount: selectedConversations.length,
      sort: "updated_desc",
    },
  };
}

async function slackApi(
  accessToken: string,
  method: string,
  params: Record<string, string | undefined>,
): Promise<SlackApiResponse> {
  const response = await fetch(`${SLACK_API_BASE_URL}/${method}`, {
    body: new URLSearchParams(removeEmptyValues(params)),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`Slack API request failed: ${response.status}`);
  }

  const body = (await response.json()) as SlackApiResponse;
  if (body.ok === false) {
    const details = body.needed ? `; needed=${body.needed}` : "";
    throw new Error(`Slack API error: ${body.error ?? "unknown"}${details}`);
  }

  return body;
}

function normalizeStreams(
  optionStreams: string[] | undefined,
  configStreams: SlackConfig["streams"],
): SlackStream[] {
  const requested = optionStreams?.length ? optionStreams : configStreams;
  const streams = requested?.length ? requested : DEFAULT_STREAMS;
  const normalized = streams.filter(isSlackStream);

  if (
    normalized.includes("recent_messages") &&
    !normalized.includes("my_messages_search")
  ) {
    return ["my_messages_search", ...normalized];
  }

  return normalized;
}

function normalizeConversationTypes(
  configTypes: SlackConfig["conversationTypes"],
): SlackConversationType[] {
  const types = configTypes?.length ? configTypes : DEFAULT_CONVERSATION_TYPES;

  return types.filter(isSlackConversationType);
}

function isSlackStream(value: string): value is SlackStream {
  return (
    [
      "assistant_search",
      "my_messages_search",
      "recent_messages",
    ] as readonly string[]
  ).includes(value);
}

function isSlackConversationType(
  value: string,
): value is SlackConversationType {
  return (
    ["im", "mpim", "private_channel", "public_channel"] as readonly string[]
  ).includes(value);
}

function clamp(value: number | undefined, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, Math.trunc(value ?? min)));
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

function getRecentMessageCoverage(
  config: SlackConfig,
  scan: SlackConversationScan,
): {
  conversationScanLimit: number;
  conversationTypes: SlackConversationType[];
  hasMoreAfterScan: boolean;
  maxConversations: number;
  messagesPerConversation: number;
  note: string;
  scannedConversationCount: number;
  selectedConversationCount: number;
  sort: "updated_desc";
  source: "conversations.history";
} {
  return {
    conversationScanLimit: scan.conversationScanLimit,
    conversationTypes: normalizeConversationTypes(config.conversationTypes),
    hasMoreAfterScan: scan.hasMoreAfterScan,
    maxConversations: scan.maxConversations,
    messagesPerConversation: clamp(config.messagesPerConversation, 1, 100),
    note: "Bounded recent conversation history. Slack conversations are scanned first, sorted by updated timestamp descending, then the selected conversations' recent histories are fetched.",
    scannedConversationCount: scan.scannedConversationCount,
    selectedConversationCount: scan.selectedConversationCount,
    sort: scan.sort,
    source: "conversations.history",
  };
}

type SlackConversationScan = {
  conversationScanLimit: number;
  hasMoreAfterScan: boolean;
  maxConversations: number;
  scannedConversationCount: number;
  selectedConversationCount: number;
  sort: "updated_desc";
};

function compareSlackUserMessages(
  left: SlackUserMessage,
  right: SlackUserMessage,
): number {
  return (
    slackTimestampToNumber(right.message.ts) -
    slackTimestampToNumber(left.message.ts)
  );
}

function slackTimestampToNumber(value: string | undefined): number {
  if (!value) {
    return 0;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : 0;
}

function sanitizeSlackUserId(userId: string): string {
  if (!/^[UW][A-Z0-9]+$/u.test(userId)) {
    throw new Error("Slack auth.test returned an invalid user_id.");
  }

  return userId;
}

function compareSlackConversationsByUpdated(
  left: SlackConversation,
  right: SlackConversation,
): number {
  return (
    slackConversationUpdatedToNumber(right) -
    slackConversationUpdatedToNumber(left)
  );
}

function slackConversationUpdatedToNumber(
  conversation: SlackConversation,
): number {
  return Number.isFinite(conversation.updated)
    ? (conversation.updated ?? 0)
    : 0;
}

function dedupeConversations(
  conversations: SlackConversation[],
): SlackConversation[] {
  const byId = new Map<string, SlackConversation>();

  for (const conversation of conversations) {
    if (conversation.id && !byId.has(conversation.id)) {
      byId.set(conversation.id, conversation);
    }
  }

  return [...byId.values()];
}

function getHistoryMessages(response: SlackApiResponse): SlackMessage[] {
  return Array.isArray(response.messages) ? response.messages : [];
}

function getSearchMessages(response: SlackApiResponse): SlackSearchMessage[] {
  return isSlackSearchMessages(response.messages)
    ? (response.messages.matches ?? [])
    : [];
}

function getSearchTotal(response: SlackApiResponse): number | undefined {
  if (!isSlackSearchMessages(response.messages)) {
    return undefined;
  }

  return response.messages.total ?? response.messages.paging?.total;
}

function isSlackSearchMessages(
  messages: SlackApiResponse["messages"],
): messages is SlackSearchMessages {
  return (
    typeof messages === "object" &&
    messages !== null &&
    !Array.isArray(messages)
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
