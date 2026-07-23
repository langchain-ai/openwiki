import {
  OPENWIKI_CONFLUENCE_API_TOKEN_ENV_KEY,
  OPENWIKI_CONFLUENCE_EMAIL_ENV_KEY,
} from "../../constants.js";
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

type ConfluenceStream = "cql_search" | "recent_blogposts" | "space_blogposts";

type ConfluenceConfig = {
  baseUrl?: string;
  bodyFormat?: "atlas_doc_format" | "storage" | "view";
  cqlQueries?: string[];
  enabled?: boolean;
  includeBody?: boolean;
  maxResults?: number;
  spaceKeys?: string[];
  streams?: ConfluenceStream[];
  windowDays?: number;
};

type ConfluenceApiResponse<T> = {
  results: T[];
  _links?: {
    next?: string;
  };
};

type ConfluenceBlogPost = {
  id: string;
  status: string;
  title: string;
  spaceId: string;
  authorId?: string;
  createdAt?: string;
  version?: {
    createdAt?: string;
    number?: number;
  };
  body?: {
    storage?: { value?: string };
    atlas_doc_format?: { value?: string };
    view?: { value?: string };
  };
  _links?: {
    webui?: string;
  };
};

type ConfluenceSpace = {
  id: string;
  key: string;
  name: string;
};

type ConfluenceSearchResult = {
  content?: ConfluenceBlogPost;
  excerpt?: string;
  lastModified?: string;
  title?: string;
  url?: string;
};

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Fetches blog posts from Atlassian Confluence Cloud using the REST API v2.",
  displayName: "Confluence",
  id: "confluence",
  requiredEnv: [
    OPENWIKI_CONFLUENCE_EMAIL_ENV_KEY,
    OPENWIKI_CONFLUENCE_API_TOKEN_ENV_KEY,
  ],
  supportsAgenticDiscovery: false,
};

export function createConfluenceConnector(): ConnectorRuntime {
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
    ...(await readConnectorConfig<ConfluenceConfig>("confluence", {
      enabled: false,
      bodyFormat: "storage",
      includeBody: true,
      maxResults: 50,
      streams: ["recent_blogposts"],
      windowDays: 7,
    })),
    ...((options.connectorConfig ?? {}) as ConfluenceConfig),
  };
  const state = await readConnectorState("confluence");
  const warnings: string[] = [];
  const rawFiles: string[] = [];

  if (!config.enabled) {
    return {
      connectorId: "confluence",
      message:
        "Confluence connector is not enabled. Set enabled=true in ~/.openwiki/connectors/confluence/config.json.",
      rawFiles,
      runId,
      statePath: "~/.openwiki/connectors/confluence/state.json",
      status: "skipped",
      warnings,
    };
  }

  const email = process.env[OPENWIKI_CONFLUENCE_EMAIL_ENV_KEY];
  const apiToken = process.env[OPENWIKI_CONFLUENCE_API_TOKEN_ENV_KEY];
  if (!email || !apiToken) {
    return {
      connectorId: "confluence",
      message: `${OPENWIKI_CONFLUENCE_EMAIL_ENV_KEY} and ${OPENWIKI_CONFLUENCE_API_TOKEN_ENV_KEY} are required for Confluence ingestion.`,
      rawFiles,
      runId,
      statePath: "~/.openwiki/connectors/confluence/state.json",
      status: "error",
      warnings,
    };
  }

  if (!config.baseUrl) {
    return {
      connectorId: "confluence",
      message: "Confluence baseUrl is required in config.",
      rawFiles,
      runId,
      statePath: "~/.openwiki/connectors/confluence/state.json",
      status: "error",
      warnings,
    };
  }

  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const streams = normalizeStreams(
    options.streams as ConfluenceStream[] | undefined,
    config.streams,
  );
  const maxResults = config.maxResults ?? 50;
  const bodyFormat = config.bodyFormat ?? "storage";
  const windowDays = config.windowDays ?? 7;
  let totalPosts = 0;

  if (streams.includes("recent_blogposts")) {
    const params = new URLSearchParams({
      sort: "-modified-date",
      limit: String(clamp(maxResults, 1, 100)),
      "body-format": bodyFormat,
    });

    const results = await fetchPaginated<ConfluenceBlogPost>(
      baseUrl,
      `/wiki/api/v2/blogposts?${params.toString()}`,
      email,
      apiToken,
      maxResults,
    );

    const recentPosts = results.filter((post) => {
      const date = post.version?.createdAt || post.createdAt;
      return date ? isWithinWindow(date, windowDays) : false;
    });

    totalPosts += recentPosts.length;

    rawFiles.push(
      await writeRawJson("confluence", runId, "recent-blogposts.json", {
        fetchedAt: new Date().toISOString(),
        instanceId: options.instanceId,
        posts: recentPosts,
        windowDays,
      }),
    );
  }

  if (streams.includes("space_blogposts")) {
    const spaceKeys = normalizeStringArray(config.spaceKeys);
    for (const spaceKey of spaceKeys) {
      const spaceId = await resolveSpaceId(baseUrl, spaceKey, email, apiToken);
      if (!spaceId) {
        warnings.push(`Could not resolve space key: ${spaceKey}`);
        continue;
      }

      const params = new URLSearchParams({
        limit: String(clamp(maxResults, 1, 100)),
        "body-format": bodyFormat,
      });

      const results = await fetchPaginated<ConfluenceBlogPost>(
        baseUrl,
        `/wiki/api/v2/spaces/${spaceId}/blogposts?${params.toString()}`,
        email,
        apiToken,
        maxResults,
      );

      totalPosts += results.length;

      rawFiles.push(
        await writeRawJson(
          "confluence",
          runId,
          `space-${spaceKey}-blogposts.json`,
          {
            fetchedAt: new Date().toISOString(),
            instanceId: options.instanceId,
            spaceId,
            spaceKey,
            posts: results,
          },
        ),
      );
    }
  }

  if (streams.includes("cql_search")) {
    const queries = normalizeStringArray(config.cqlQueries);
    const searchResults = [];
    for (const query of queries) {
      const cql = query.includes("type=blogpost")
        ? query
        : `type=blogpost AND ${query}`;
      const params = new URLSearchParams({
        cql,
        limit: String(clamp(maxResults, 1, 100)),
      });

      const results = await fetchPaginated<ConfluenceSearchResult>(
        baseUrl,
        `/wiki/rest/api/search?${params.toString()}`,
        email,
        apiToken,
        maxResults,
      );

      totalPosts += results.length;
      searchResults.push({
        query: cql,
        results,
      });
    }
    if (searchResults.length > 0) {
      rawFiles.push(
        await writeRawJson("confluence", runId, "cql-search-results.json", {
          fetchedAt: new Date().toISOString(),
          instanceId: options.instanceId,
          queries: searchResults,
        }),
      );
    }
  }

  await writeConnectorState(
    "confluence",
    updateStateWithRun(state, {
      at: new Date().toISOString(),
      rawFiles,
      runId,
      status: "success",
      warnings,
    }),
  );

  return {
    connectorId: "confluence",
    message: `Fetched ${totalPosts} blog posts from Confluence.`,
    rawFiles,
    runId,
    statePath: "~/.openwiki/connectors/confluence/state.json",
    status: "success",
    warnings,
  };
}

function normalizeStreams(
  optionStreams?: ConfluenceStream[],
  configStreams?: ConfluenceStream[],
): ConfluenceStream[] {
  const streams = optionStreams ?? configStreams ?? ["recent_blogposts"];
  const validStreams = new Set([
    "cql_search",
    "recent_blogposts",
    "space_blogposts",
  ]);
  const filtered = streams.filter((s) => validStreams.has(s));
  return filtered.length > 0 ? filtered : ["recent_blogposts"];
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
    : [];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isWithinWindow(dateString: string, windowDays: number): boolean {
  const date = new Date(dateString);
  const now = new Date();
  const diffTime = Math.abs(now.getTime() - date.getTime());
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays <= windowDays;
}

async function confluenceApi<T>(
  baseUrl: string,
  path: string,
  email: string,
  apiToken: string,
): Promise<T> {
  const url = `${baseUrl}${path}`;
  const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");

  const response = await fetch(url, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Confluence API error: ${response.status} ${response.statusText} for ${url}`,
    );
  }

  return response.json() as Promise<T>;
}

async function fetchPaginated<T>(
  baseUrl: string,
  path: string,
  email: string,
  apiToken: string,
  maxResults: number,
): Promise<T[]> {
  const results: T[] = [];
  let currentPath: string | undefined = path;
  let remaining = maxResults;

  while (currentPath && remaining > 0) {
    const response: ConfluenceApiResponse<T> = await confluenceApi(
      baseUrl,
      currentPath,
      email,
      apiToken,
    );

    if (response.results) {
      const chunk = response.results.slice(0, remaining);
      results.push(...chunk);
      remaining -= chunk.length;
    }

    currentPath = response._links?.next;
  }

  return results;
}

async function resolveSpaceId(
  baseUrl: string,
  spaceKey: string,
  email: string,
  apiToken: string,
): Promise<string | undefined> {
  const params = new URLSearchParams({ keys: spaceKey });
  const response = await confluenceApi<ConfluenceApiResponse<ConfluenceSpace>>(
    baseUrl,
    `/wiki/api/v2/spaces?${params.toString()}`,
    email,
    apiToken,
  );

  return response.results?.[0]?.id;
}
