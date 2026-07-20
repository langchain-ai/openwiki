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
import { OPENWIKI_X_ACCESS_TOKEN_ENV_KEY } from "../../constants.js";
import { getOAuthAccessToken } from "../../auth/tokens.js";

type XConfig = {
  enabled?: boolean;
  listIds?: string[];
  maxPagesPerStream?: number;
  streams?: XStream[];
  userId?: string;
};

type XStream =
  "bookmarks" | "home_timeline" | "list_posts" | "mentions" | "user_posts";

type XApiPage = {
  data?: { id?: string }[];
  errors?: unknown[];
  includes?: unknown;
  meta?: {
    newest_id?: string;
    next_token?: string;
    result_count?: number;
  };
};

const X_API_BASE_URL = "https://api.x.com/2";
const DEFAULT_STREAMS: XStream[] = [
  "home_timeline",
  "user_posts",
  "mentions",
  "bookmarks",
  "list_posts",
];

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Fetches X/Twitter user timelines, mentions, list posts, and bookmarks through X API v2 with OAuth user context.",
  displayName: "X / Twitter",
  id: "x",
  requiredEnv: [OPENWIKI_X_ACCESS_TOKEN_ENV_KEY],
  supportsAgenticDiscovery: false,
};

export function createXConnector(): ConnectorRuntime {
  return {
    ...definition,
    ingest,
  };
}

async function ingest(
  options: ConnectorIngestOptions = {},
): Promise<ConnectorIngestResult> {
  const runId = createRunId();
  const config = {
    ...(await readConnectorConfig<XConfig>("x", {
      enabled: false,
      listIds: [],
      maxPagesPerStream: 2,
      streams: DEFAULT_STREAMS,
    })),
    ...((options.connectorConfig ?? {}) as XConfig),
  };
  const state = await readConnectorState("x");
  const warnings: string[] = [];
  const rawFiles: string[] = [];

  if (!config.enabled) {
    return {
      connectorId: "x",
      message:
        "X connector is not enabled. Configure ~/.openwiki/connectors/x/config.json and set OPENWIKI_X_ACCESS_TOKEN in ~/.openwiki/.env.",
      rawFiles,
      runId,
      statePath: "~/.openwiki/connectors/x/state.json",
      status: "skipped",
      warnings,
    };
  }

  if (!process.env[OPENWIKI_X_ACCESS_TOKEN_ENV_KEY]) {
    return {
      connectorId: "x",
      message: `${OPENWIKI_X_ACCESS_TOKEN_ENV_KEY} is required for X ingestion.`,
      rawFiles,
      runId,
      statePath: "~/.openwiki/connectors/x/state.json",
      status: "error",
      warnings,
    };
  }

  const accessToken = await getOAuthAccessToken("x");
  const streams = normalizeStreams(options.streams, config.streams);
  const userId = config.userId ?? (await fetchAuthenticatedUserId(accessToken));
  const latestIds = { ...(state.latestIds ?? {}) };
  const startTime = getWindowStartTime(options.windowHours);

  for (const stream of streams) {
    if (stream === "list_posts") {
      for (const listId of config.listIds ?? []) {
        const key = `list_posts:${listId}`;
        const pages = await fetchPaginatedX(
          accessToken,
          `/lists/${encodeURIComponent(listId)}/tweets`,
          {
            since_id: latestIds[key],
            start_time: startTime,
          },
          config.maxPagesPerStream,
        );
        latestIds[key] = getNewestId(pages) ?? latestIds[key] ?? "";
        rawFiles.push(
          await writeRawJson("x", runId, `list-${listId}.json`, {
            fetchedAt: new Date().toISOString(),
            listId,
            pages,
            stream,
            windowHours: normalizeWindowHours(options.windowHours),
          }),
        );
      }
      continue;
    }

    const key = stream;
    const pages = await fetchPaginatedX(
      accessToken,
      getStreamPath(stream, userId),
      stream === "bookmarks"
        ? {}
        : { since_id: latestIds[key], start_time: startTime },
      config.maxPagesPerStream,
    );
    latestIds[key] = getNewestId(pages) ?? latestIds[key] ?? "";
    rawFiles.push(
      await writeRawJson("x", runId, `${stream}.json`, {
        fetchedAt: new Date().toISOString(),
        pages,
        stream,
        userId,
        windowHours: normalizeWindowHours(options.windowHours),
      }),
    );
  }

  const nextState = updateStateWithRun(
    {
      ...state,
      latestIds: removeEmptyValues(latestIds),
    },
    {
      at: new Date().toISOString(),
      rawFiles,
      runId,
      status: rawFiles.length > 0 ? "success" : "skipped",
      warnings,
    },
  );
  await writeConnectorState("x", nextState);

  return {
    connectorId: "x",
    message: `Fetched ${rawFiles.length} X stream dump(s).`,
    rawFiles,
    runId,
    statePath: "~/.openwiki/connectors/x/state.json",
    status: rawFiles.length > 0 ? "success" : "skipped",
    warnings,
  };
}

async function fetchAuthenticatedUserId(accessToken: string): Promise<string> {
  const response = await fetchX(accessToken, "/users/me", {});
  const userId = getNestedString(response, ["data", "id"]);

  if (!userId) {
    throw new Error(
      "Could not resolve authenticated X user ID from /2/users/me.",
    );
  }

  return userId;
}

async function fetchPaginatedX(
  accessToken: string,
  endpointPath: string,
  incrementalParams: Record<string, string | undefined>,
  maxPages = 2,
): Promise<XApiPage[]> {
  const pages: XApiPage[] = [];
  let paginationToken: string | undefined;

  for (let pageIndex = 0; pageIndex < Math.max(1, maxPages); pageIndex += 1) {
    const page = await fetchX(accessToken, endpointPath, {
      ...getDefaultTweetParams(),
      ...removeEmptyValues(incrementalParams),
      max_results: "100",
      pagination_token: paginationToken,
    });
    pages.push(page);
    paginationToken = page.meta?.next_token;

    if (!paginationToken) {
      break;
    }
  }

  return pages;
}

async function fetchX(
  accessToken: string,
  endpointPath: string,
  params: Record<string, string | undefined>,
): Promise<XApiPage> {
  const url = new URL(`${X_API_BASE_URL}${endpointPath}`);
  for (const [key, value] of Object.entries(removeEmptyValues(params))) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `X API request failed: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as XApiPage;
}

function getStreamPath(
  stream: Exclude<XStream, "list_posts">,
  userId: string,
): string {
  if (stream === "home_timeline") {
    return `/users/${encodeURIComponent(userId)}/timelines/reverse_chronological`;
  }

  if (stream === "user_posts") {
    return `/users/${encodeURIComponent(userId)}/tweets`;
  }

  if (stream === "mentions") {
    return `/users/${encodeURIComponent(userId)}/mentions`;
  }

  return `/users/${encodeURIComponent(userId)}/bookmarks`;
}

function getDefaultTweetParams(): Record<string, string> {
  return {
    expansions: "author_id,attachments.media_keys,referenced_tweets.id",
    "media.fields":
      "alt_text,duration_ms,height,media_key,preview_image_url,public_metrics,type,url,width",
    "tweet.fields":
      "attachments,author_id,created_at,entities,id,lang,note_tweet,public_metrics,referenced_tweets,text",
    "user.fields":
      "created_at,description,id,name,profile_image_url,public_metrics,url,username,verified",
  };
}

function normalizeStreams(
  optionStreams: string[] | undefined,
  configStreams: XConfig["streams"],
): XStream[] {
  const requested = optionStreams?.length ? optionStreams : configStreams;
  const streams = requested?.length ? requested : DEFAULT_STREAMS;

  return streams.filter(isXStream);
}

function isXStream(value: string): value is XStream {
  return (DEFAULT_STREAMS as readonly string[]).includes(value);
}

function getNewestId(pages: XApiPage[]): string | undefined {
  return pages.find((page) => page.meta?.newest_id)?.meta?.newest_id;
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

function getWindowStartTime(
  windowHours: number | undefined,
): string | undefined {
  const hours = normalizeWindowHours(windowHours);

  if (hours === null) {
    return undefined;
  }

  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function normalizeWindowHours(windowHours: number | undefined): number | null {
  if (typeof windowHours !== "number" || !Number.isFinite(windowHours)) {
    return null;
  }

  return Math.max(1, Math.min(168, Math.trunc(windowHours)));
}

function getNestedString(value: unknown, path: string[]): string | null {
  let current = value;

  for (const part of path) {
    if (current === null || typeof current !== "object" || !(part in current)) {
      return null;
    }

    current = (current as Record<string, unknown>)[part];
  }

  return typeof current === "string" ? current : null;
}
