import {
  createRunId,
  readConnectorConfig,
  readConnectorState,
  updateStateWithRun,
  writeConnectorState,
  writeRawJson,
} from "../io.js";
import { fetchWithResilience } from "../http.js";
import { normalizeStringArray } from "../config.js";
import { openWikiConnectorsDisplayPath } from "../../config/openwiki-home.js";
import type {
  ConnectorDefinition,
  ConnectorIngestOptions,
  ConnectorIngestResult,
  ConnectorRuntime,
} from "../types.js";

type HackerNewsConfig = {
  enabled?: boolean;
  feeds?: unknown;
  maxItemsPerFeed?: number;
  maxResultsPerQuery?: number;
  queries?: unknown;
  queryTags?: unknown;
};

type HackerNewsFeed = "ask" | "best" | "job" | "new" | "show" | "top";

type HackerNewsItem = {
  by?: string;
  descendants?: number;
  id: number;
  kids?: number[];
  score?: number;
  text?: string;
  time?: number;
  title?: string;
  type?: string;
  url?: string;
};

type AlgoliaHit = {
  author?: string;
  comment_text?: string;
  created_at?: string;
  num_comments?: number;
  objectID?: string;
  points?: number;
  story_id?: number;
  story_text?: string;
  story_title?: string;
  story_url?: string;
  title?: string;
  url?: string;
};

type AlgoliaResponse = {
  hits?: AlgoliaHit[];
  nbHits?: number;
  page?: number;
};

const HN_FIREBASE_BASE_URL = "https://hacker-news.firebaseio.com/v0";
const HN_ALGOLIA_SEARCH_URL = "https://hn.algolia.com/api/v1/search_by_date";
const DEFAULT_FEEDS: HackerNewsFeed[] = ["top", "new"];
const VALID_FEEDS: readonly HackerNewsFeed[] = [
  "ask",
  "best",
  "job",
  "new",
  "show",
  "top",
];

type FeedSelection = {
  feeds: HackerNewsFeed[];
  invalidFeeds: string[];
  source: "configured" | "default" | "requested";
};

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Fetches Hacker News feeds and query results through public Hacker News APIs.",
  displayName: "Hacker News",
  id: "hackernews",
  mode: "personal",
  requiredEnv: [],
  supportsAgenticDiscovery: false,
};

export function createHackerNewsConnector(): ConnectorRuntime {
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
    ...(await readConnectorConfig<HackerNewsConfig>("hackernews", {
      enabled: true,
      feeds: DEFAULT_FEEDS,
      maxItemsPerFeed: 30,
      maxResultsPerQuery: 20,
      queries: [],
      queryTags: ["story"],
    })),
    ...((options.connectorConfig ?? {}) as HackerNewsConfig),
  };
  const state = await readConnectorState("hackernews");
  const warnings: string[] = [];
  const rawFiles: string[] = [];

  if (!config.enabled) {
    return {
      connectorId: "hackernews",
      message: `Hacker News connector is not enabled. Set enabled=true in ${openWikiConnectorsDisplayPath}/hackernews/config.json.`,
      rawFiles,
      runId,
      statePath: `${openWikiConnectorsDisplayPath}/hackernews/state.json`,
      status: "skipped",
      warnings,
    };
  }

  const feedLimit = getOptionLimit(options.limit, config.maxItemsPerFeed, 100);
  const queryLimit = getOptionLimit(
    options.limit,
    config.maxResultsPerQuery,
    100,
  );
  const feedSelection = normalizeFeeds(options.streams, config.feeds);
  const feeds = feedSelection.feeds;
  const invalidFeedsWarning = getInvalidFeedsWarning(feedSelection);
  if (invalidFeedsWarning) {
    warnings.push(invalidFeedsWarning);
  }
  const queries = normalizeStringArray(config.queries);
  if (feeds.length === 0 && queries.length === 0) {
    return await finishHackerNewsRun({
      message:
        "No valid Hacker News feeds were configured or requested, and no Hacker News search queries are configured. Add at least one valid feed or query.",
      rawFiles,
      runId,
      state,
      status: "error",
      warnings,
    });
  }

  const windowHours = normalizeWindowHours(options.windowHours);
  const earliestUnixTime =
    windowHours === null
      ? null
      : Math.floor((Date.now() - windowHours * 60 * 60 * 1000) / 1000);
  const feedResults = [];

  for (const feed of feeds) {
    try {
      const ids = (await hnFirebaseApi<number[]>(`/${feed}stories.json`)).slice(
        0,
        feedLimit,
      );
      const items = [];
      for (const id of ids) {
        const item = await hnFirebaseApi<HackerNewsItem>(
          `/item/${encodeURIComponent(String(id))}.json`,
        );
        if (item && isWithinWindow(item.time, earliestUnixTime)) {
          items.push(item);
        }
      }
      feedResults.push({
        feed,
        ids,
        items,
      });
    } catch (error) {
      warnings.push(`${feed}: ${getErrorMessage(error)}`);
    }
  }

  const queryResults = [];
  const tags = normalizeStringArray(config.queryTags);
  for (const query of queries) {
    try {
      queryResults.push({
        query,
        response: await searchHackerNews(query, {
          earliestUnixTime,
          hitsPerPage: queryLimit,
          tags,
        }),
      });
    } catch (error) {
      warnings.push(`${query}: ${getErrorMessage(error)}`);
    }
  }

  rawFiles.push(
    await writeRawJson("hackernews", runId, "hackernews-results.json", {
      feeds: feedResults,
      fetchedAt: new Date().toISOString(),
      instanceId: options.instanceId,
      queryResults,
      windowHours,
    }),
  );

  return await finishHackerNewsRun({
    message: `Fetched ${feedResults.length} Hacker News feed(s) and ${queryResults.length} search quer${
      queryResults.length === 1 ? "y" : "ies"
    }.`,
    rawFiles,
    runId,
    state,
    status: rawFiles.length > 0 ? "success" : "skipped",
    warnings,
  });
}

async function finishHackerNewsRun({
  message,
  rawFiles,
  runId,
  state,
  status,
  warnings,
}: {
  message: string;
  rawFiles: string[];
  runId: string;
  state: Awaited<ReturnType<typeof readConnectorState>>;
  status: ConnectorIngestResult["status"];
  warnings: string[];
}): Promise<ConnectorIngestResult> {
  await writeConnectorState(
    "hackernews",
    updateStateWithRun(state, {
      at: new Date().toISOString(),
      rawFiles,
      runId,
      status,
      warnings,
    }),
  );

  return {
    connectorId: "hackernews",
    message,
    rawFiles,
    runId,
    statePath: `${openWikiConnectorsDisplayPath}/hackernews/state.json`,
    status,
    warnings,
  };
}

async function hnFirebaseApi<T>(endpointPath: string): Promise<T> {
  const response = await fetchWithResilience(
    `${HN_FIREBASE_BASE_URL}${endpointPath}`,
  );

  if (!response.ok) {
    throw new Error(
      `Hacker News API request failed: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as T;
}

async function searchHackerNews(
  query: string,
  {
    earliestUnixTime,
    hitsPerPage,
    tags,
  }: {
    earliestUnixTime: number | null;
    hitsPerPage: number;
    tags: string[];
  },
): Promise<AlgoliaResponse> {
  const url = new URL(HN_ALGOLIA_SEARCH_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("hitsPerPage", String(hitsPerPage));
  if (tags.length > 0) {
    url.searchParams.set("tags", tags.join(","));
  }
  if (earliestUnixTime !== null) {
    url.searchParams.set("numericFilters", `created_at_i>${earliestUnixTime}`);
  }

  const response = await fetchWithResilience(url);
  if (!response.ok) {
    throw new Error(
      `Hacker News search request failed: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as AlgoliaResponse;
}

function normalizeFeeds(
  optionFeeds: unknown,
  configFeeds: HackerNewsConfig["feeds"],
): FeedSelection {
  const requestedFeeds = normalizeExplicitFeeds(optionFeeds);
  if (requestedFeeds) {
    return {
      ...requestedFeeds,
      source: "requested",
    };
  }

  const configuredFeeds = normalizeExplicitFeeds(configFeeds);
  if (configuredFeeds) {
    return {
      ...configuredFeeds,
      source: "configured",
    };
  }

  return {
    feeds: DEFAULT_FEEDS,
    invalidFeeds: [],
    source: "default",
  };
}

function normalizeExplicitFeeds(
  value: unknown,
): Pick<FeedSelection, "feeds" | "invalidFeeds"> | null {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) {
    return null;
  }

  const values = normalizeStringArray(value);
  const feeds: HackerNewsFeed[] = [];
  const invalidFeeds: string[] = [];

  for (const feed of values) {
    if (isHackerNewsFeed(feed)) {
      feeds.push(feed);
    } else {
      invalidFeeds.push(feed);
    }
  }

  if (!Array.isArray(value)) {
    invalidFeeds.push(`non-array ${typeof value}`);
  } else if (values.length < value.length) {
    invalidFeeds.push("non-string or blank value");
  }

  return {
    feeds,
    invalidFeeds,
  };
}

function getInvalidFeedsWarning(selection: FeedSelection): string | null {
  if (selection.invalidFeeds.length === 0) {
    return null;
  }

  return `Ignored invalid Hacker News ${selection.source} feed(s): ${selection.invalidFeeds.join(
    ", ",
  )}. Valid feeds are: ${VALID_FEEDS.join(", ")}.`;
}

function isHackerNewsFeed(value: string): value is HackerNewsFeed {
  return (VALID_FEEDS as readonly string[]).includes(value);
}

function isWithinWindow(
  itemUnixTime: number | undefined,
  earliestUnixTime: number | null,
): boolean {
  return earliestUnixTime === null || (itemUnixTime ?? 0) >= earliestUnixTime;
}

function normalizeWindowHours(windowHours: number | undefined): number | null {
  if (typeof windowHours !== "number" || !Number.isFinite(windowHours)) {
    return null;
  }

  return Math.max(1, Math.min(168, Math.trunc(windowHours)));
}

function getOptionLimit(
  optionLimit: number | undefined,
  configLimit: number | undefined,
  max: number,
): number {
  const limit = optionLimit ?? configLimit ?? max;
  return Math.max(1, Math.min(max, Math.trunc(limit)));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
