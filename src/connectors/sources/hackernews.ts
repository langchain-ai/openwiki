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

type HackerNewsConfig = {
  enabled?: boolean;
  feeds?: HackerNewsFeed[];
  maxItemsPerFeed?: number;
  maxResultsPerQuery?: number;
  queries?: string[];
  queryTags?: string[];
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

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Fetches Hacker News feeds and query results through public Hacker News APIs.",
  displayName: "Hacker News",
  id: "hackernews",
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
      message:
        "Hacker News connector is not enabled. Set enabled=true in ~/.openwiki/connectors/hackernews/config.json.",
      rawFiles,
      runId,
      statePath: "~/.openwiki/connectors/hackernews/state.json",
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
  const feeds = normalizeFeeds(options.streams, config.feeds);
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
  const queries = normalizeStringArray(config.queries);
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

  await writeConnectorState(
    "hackernews",
    updateStateWithRun(state, {
      at: new Date().toISOString(),
      rawFiles,
      runId,
      status: rawFiles.length > 0 ? "success" : "skipped",
      warnings,
    }),
  );

  return {
    connectorId: "hackernews",
    message: `Fetched ${feedResults.length} Hacker News feed(s) and ${queryResults.length} search quer${
      queryResults.length === 1 ? "y" : "ies"
    }.`,
    rawFiles,
    runId,
    statePath: "~/.openwiki/connectors/hackernews/state.json",
    status: rawFiles.length > 0 ? "success" : "skipped",
    warnings,
  };
}

async function hnFirebaseApi<T>(endpointPath: string): Promise<T> {
  const response = await fetch(`${HN_FIREBASE_BASE_URL}${endpointPath}`);

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

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Hacker News search request failed: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as AlgoliaResponse;
}

function normalizeFeeds(
  optionFeeds: string[] | undefined,
  configFeeds: HackerNewsConfig["feeds"],
): HackerNewsFeed[] {
  const feeds = optionFeeds?.length ? optionFeeds : configFeeds;
  return (feeds?.length ? feeds : DEFAULT_FEEDS).filter(isHackerNewsFeed);
}

function isHackerNewsFeed(value: string): value is HackerNewsFeed {
  return (
    value === "ask" ||
    value === "best" ||
    value === "job" ||
    value === "new" ||
    value === "show" ||
    value === "top"
  );
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
    : [];
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
