import { TavilySearch } from "@langchain/tavily";
import {
  OPENWIKI_OLLAMA_API_KEY_ENV_KEY,
  OPENWIKI_TAVILY_API_KEY_ENV_KEY,
} from "../../config/constants.js";
import { normalizeStringArray } from "../config.js";
import {
  createRunId,
  readConnectorConfig,
  readConnectorState,
  updateStateWithRun,
  writeConnectorState,
  writeRawJson,
} from "../io.js";
import { openWikiConnectorsDisplayPath } from "../../config/openwiki-home.js";
import type {
  ConnectorDefinition,
  ConnectorIngestOptions,
  ConnectorIngestResult,
  ConnectorRuntime,
} from "../types.js";

type WebSearchConfig = {
  enabled?: boolean;
  excludeDomains?: string[];
  includeAnswer?: boolean;
  includeDomains?: string[];
  includeImages?: boolean;
  includeRawContent?: boolean;
  maxResults?: number;
  provider?: "ollama" | "tavily";
  queries?: string[];
  searchDepth?: "advanced" | "basic";
  timeRange?: "day" | "month" | "week" | "year";
  topic?: "general" | "news";
  urls?: string[];
};

type TavilySearchResult = {
  answer?: string;
  images?: unknown[];
  query?: string;
  results?: unknown[];
};

type OllamaSearchResult = {
  results?: unknown[];
};

type OllamaFetchResult = {
  content?: string;
  links?: unknown[];
  title?: string;
};

const OLLAMA_WEB_SEARCH_URL = "https://ollama.com/api/web_search";
const OLLAMA_WEB_FETCH_URL = "https://ollama.com/api/web_fetch";

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Fetches web search results (and Ollama URL fetches) with Tavily through the LangChain Tavily integration, or with Ollama's web_search and web_fetch APIs.",
  displayName: "Web Search",
  id: "web-search",
  mode: "personal",
  requiredEnv: [OPENWIKI_TAVILY_API_KEY_ENV_KEY],
  supportsAgenticDiscovery: false,
};

export function createWebSearchConnector(): ConnectorRuntime {
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
    ...(await readConnectorConfig<WebSearchConfig>("web-search", {
      enabled: true,
      includeAnswer: true,
      includeImages: false,
      includeRawContent: false,
      maxResults: 5,
      provider: "tavily",
      queries: [],
      searchDepth: "basic",
      topic: "general",
    })),
    ...((options.connectorConfig ?? {}) as WebSearchConfig),
  };
  const provider = normalizeProvider(config.provider);
  const state = await readConnectorState("web-search");
  const warnings: string[] = [];
  const rawFiles: string[] = [];

  if (!config.enabled) {
    return {
      connectorId: "web-search",
      message: `Web Search connector is not enabled. Set enabled=true in ${openWikiConnectorsDisplayPath}/web-search/config.json.`,
      rawFiles,
      runId,
      statePath: `${openWikiConnectorsDisplayPath}/web-search/state.json`,
      status: "skipped",
      warnings,
    };
  }

  const tavilyApiKey = process.env[OPENWIKI_TAVILY_API_KEY_ENV_KEY];
  const ollamaApiKey = process.env[OPENWIKI_OLLAMA_API_KEY_ENV_KEY];
  const requiredKeyEnv =
    provider === "ollama"
      ? OPENWIKI_OLLAMA_API_KEY_ENV_KEY
      : OPENWIKI_TAVILY_API_KEY_ENV_KEY;
  const apiKey = provider === "ollama" ? ollamaApiKey : tavilyApiKey;
  if (!apiKey) {
    return {
      connectorId: "web-search",
      message: `${requiredKeyEnv} is required for Web Search ingestion with the ${provider} provider.`,
      rawFiles,
      runId,
      statePath: `${openWikiConnectorsDisplayPath}/web-search/state.json`,
      status: "error",
      warnings,
    };
  }

  const queries = normalizeStringArray(config.queries);
  const urls = normalizeStringArray(config.urls);
  if (queries.length === 0 && (provider !== "ollama" || urls.length === 0)) {
    return {
      connectorId: "web-search",
      message: `No web search queries configured. Add queries to ${openWikiConnectorsDisplayPath}/web-search/config.json.`,
      rawFiles,
      runId,
      statePath: `${openWikiConnectorsDisplayPath}/web-search/state.json`,
      status: "skipped",
      warnings,
    };
  }

  if (provider === "ollama") {
    if (queries.length === 0) {
      warnings.push(
        "No queries configured; only configured URLs will be fetched with Ollama web_fetch.",
      );
    }
  } else if (urls.length > 0) {
    warnings.push(
      "URL fetching is only supported with provider=ollama; the configured URLs were ignored.",
    );
  }

  const limit = getOptionLimit(options.limit, config.maxResults);
  const timeRange = getWindowedTimeRange(config.timeRange, options.windowHours);

  const results = [];
  if (provider === "ollama") {
    for (const query of queries) {
      results.push({
        query,
        response: await ollamaWebSearch(apiKey, query, Math.min(limit, 10)),
      });
    }
    for (const url of urls) {
      results.push({
        query: url,
        response: await ollamaWebFetch(apiKey, url),
      });
    }
  } else {
    const tool = new TavilySearch({
      excludeDomains: normalizeStringArray(config.excludeDomains),
      includeAnswer: config.includeAnswer ?? true,
      includeDomains: normalizeStringArray(config.includeDomains),
      includeImages: config.includeImages ?? false,
      includeRawContent: config.includeRawContent ?? false,
      maxResults: limit,
      searchDepth: normalizeSearchDepth(config.searchDepth),
      tavilyApiKey: apiKey,
      timeRange,
      topic: normalizeTopic(config.topic),
    });

    for (const query of queries) {
      results.push({
        query,
        response: (await tool.invoke({ query })) as TavilySearchResult,
      });
    }
  }

  rawFiles.push(
    await writeRawJson("web-search", runId, "web-search-results.json", {
      fetchedAt: new Date().toISOString(),
      instanceId: options.instanceId,
      maxResults: limit,
      provider,
      queryCount: queries.length,
      results,
      searchDepth: normalizeSearchDepth(config.searchDepth),
      timeRange,
      topic: normalizeTopic(config.topic),
      urlCount: urls.length,
      windowHours: normalizeWindowHours(options.windowHours),
    }),
  );

  await writeConnectorState(
    "web-search",
    updateStateWithRun(state, {
      at: new Date().toISOString(),
      rawFiles,
      runId,
      status: "success",
      warnings,
    }),
  );

  return {
    connectorId: "web-search",
    message: `Fetched ${
      provider === "ollama" ? "Ollama" : "Tavily"
    } results for ${queries.length} web search quer${
      queries.length === 1 ? "y" : "ies"
    }${urls.length > 0 ? ` and ${urls.length} URL${urls.length === 1 ? "" : "s"}` : ""}.`,
    rawFiles,
    runId,
    statePath: `${openWikiConnectorsDisplayPath}/web-search/state.json`,
    status: "success",
    warnings,
  };
}

function normalizeProvider(
  value: WebSearchConfig["provider"],
): "ollama" | "tavily" {
  return value === "ollama" ? "ollama" : "tavily";
}

async function ollamaWebSearch(
  apiKey: string,
  query: string,
  maxResults: number,
): Promise<OllamaSearchResult> {
  return (await ollamaPost(OLLAMA_WEB_SEARCH_URL, apiKey, {
    max_results: maxResults,
    query,
  })) as OllamaSearchResult;
}

async function ollamaWebFetch(
  apiKey: string,
  url: string,
): Promise<OllamaFetchResult> {
  return (await ollamaPost(OLLAMA_WEB_FETCH_URL, apiKey, {
    url,
  })) as OllamaFetchResult;
}

async function ollamaPost(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Ollama API request to ${url} failed with ${response.status}: ${text.slice(0, 200)}`,
    );
  }

  return JSON.parse(text) as unknown;
}

function normalizeSearchDepth(
  value: WebSearchConfig["searchDepth"],
): "advanced" | "basic" {
  return value === "advanced" ? "advanced" : "basic";
}

function normalizeTopic(value: WebSearchConfig["topic"]): "general" | "news" {
  return value === "news" ? "news" : "general";
}

function normalizeTimeRange(
  value: WebSearchConfig["timeRange"],
): "day" | "month" | "week" | "year" | undefined {
  return value === "day" ||
    value === "month" ||
    value === "week" ||
    value === "year"
    ? value
    : undefined;
}

function getWindowedTimeRange(
  configuredTimeRange: WebSearchConfig["timeRange"],
  windowHours: number | undefined,
): "day" | "month" | "week" | "year" | undefined {
  const normalized = normalizeTimeRange(configuredTimeRange);
  if (normalized) {
    return normalized;
  }

  const hours = normalizeWindowHours(windowHours);
  return hours !== null && hours <= 24 ? "day" : normalized;
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
): number {
  const limit = optionLimit ?? configLimit ?? 5;
  return Math.max(1, Math.min(20, Math.trunc(limit)));
}
