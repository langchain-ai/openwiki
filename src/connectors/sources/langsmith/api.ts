import { Client } from "langsmith";
import type { Run } from "langsmith";

/**
 * Fields requested for the trace-tree fetch. Explicit so fields we do not list
 * never leave LangSmith. Deliberately EXCLUDES inputs/outputs: `select` is a
 * server-side field filter, so omitting them means LangSmith never sends them.
 * A coding agent's run payloads are enormous (observed ~4 MB/run, ~200 MB/trace)
 * and would blow the request timeout, and they never reach the committed page.
 * We keep structure (parent/trace ids, run type, names), timings, tokens, and
 * the small `error` field (the failure signature we actually document).
 */
const RUN_SELECT_FIELDS = [
  "end_time",
  "error",
  "id",
  "name",
  "parent_run_id",
  "run_type",
  "start_time",
  "status",
  "total_tokens",
  "trace_id",
];

/**
 * Lean fields for the recent-root-run query (used only to pick trace ids and
 * summarize the sample); no payloads.
 */
const ROOT_SELECT_FIELDS = [
  "end_time",
  "error",
  "id",
  "name",
  "start_time",
  "status",
  "total_tokens",
  "trace_id",
];

/**
 * Runs fetched per trace tree; a backstop against a pathological deep trace.
 */
const MAX_TRACE_RUNS = 500;

/**
 * Retry policy for transient LangSmith rate limits (HTTP 429). Bounded so a
 * throttled tenant can never hang the run: a handful of attempts with growing
 * backoff, after which the caller's fail-open turns it into a warning. A busy
 * tenant is common (tracing writes compete with the connector's reads), so one
 * 429 should not lose the whole pull.
 */
const MAX_RETRY_ATTEMPTS = 5;
const BASE_RETRY_DELAY_MS = 750;

/**
 * Per-request timeout. A slow or throttled tenant must fail-open, never hang the
 * whole update; combined with disabling the SDK's own retry (we own the 429
 * backoff), this bounds every SDK call so the pull always finishes.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * A resolved LangSmith project: its UUID and canonical UI URL base.
 */
export interface ResolvedProject {
  /**
   * Project UUID, required by run queries.
   */
  id: string;

  /**
   * Canonical LangSmith UI URL for the project.
   */
  url: string;
}

/**
 * The operations the LangSmith connector needs from the SDK.
 */
export interface LangSmithApi {
  /**
   * Resolves a project (tracing session) name to its UUID and URL base.
   */
  resolveProject(name: string): Promise<ResolvedProject>;

  /**
   * Root runs (newest first, capped at limit) since startTime, or with no lower
   * bound when startTime is undefined. Lean fields only (no payloads) — this is
   * the recent batch the connector classifies client-side into the
   * anomaly-weighted sample before fetching full trees.
   */
  listRootRuns(
    projectId: string,
    options: {
      limit: number;
      startTime?: string;
    },
  ): Promise<Run[]>;

  /**
   * All runs in one trace (root plus descendants), for full-tree compaction.
   */
  fetchTrace(traceId: string): Promise<Run[]>;
}

/**
 * Creates a LangSmith API wrapper bound to one base URL and API key. The key is
 * handed to the SDK Client and never stored on the returned object, so it cannot
 * leak through logging or serialization of the wrapper.
 */
export function createLangSmithApi(
  baseUrl: string,
  apiKey: string,
): LangSmithApi {
  const client = new Client({
    apiKey,
    apiUrl: baseUrl,
    // Bound each request so a slow/throttled tenant can never hang the pull, and
    // disable the SDK's own retry so it does not churn for minutes inside a single
    // call and compound our bounded 429 backoff.
    callerOptions: { maxRetries: 0 },
    timeout_ms: REQUEST_TIMEOUT_MS,
  });

  return {
    async resolveProject(name) {
      return withRateLimitRetry(async () => {
        const project = await client.readProject({ projectName: name });
        const url = await client.getProjectUrl({ projectId: project.id });
        return { id: project.id, url };
      });
    },

    async listRootRuns(projectId, { limit, startTime }) {
      return withRateLimitRetry(() =>
        drainCapped(
          client.listRuns({
            isRoot: true,
            limit,
            order: "desc",
            projectId,
            select: ROOT_SELECT_FIELDS,
            ...(startTime ? { startTime: new Date(startTime) } : {}),
          }),
          limit,
        ),
      );
    },

    async fetchTrace(traceId) {
      return withRateLimitRetry(() =>
        drainCapped(
          client.listRuns({ select: RUN_SELECT_FIELDS, traceId }),
          MAX_TRACE_RUNS,
        ),
      );
    },
  };
}

/**
 * True when the error is a LangSmith rate-limit (HTTP 429). The SDK throws a
 * plain Error whose message carries the status, e.g. "... Received status [429]:
 * ... Rate limit exceeded".
 */
export function isRateLimitError(error: unknown): boolean {
  if (
    error !== null &&
    typeof error === "object" &&
    "status" in error &&
    (error as { status?: unknown }).status === 429
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b/u.test(message) || /rate limit/iu.test(message);
}

/**
 * Runs an operation, retrying only on rate-limit errors with exponential backoff
 * plus jitter, bounded at MAX_RETRY_ATTEMPTS; any other error rethrows at once.
 * For the async-generator list calls this restarts the whole capped drain, so a
 * retry never yields partial or duplicated results.
 */
async function withRateLimitRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= MAX_RETRY_ATTEMPTS || !isRateLimitError(error)) {
        throw error;
      }
      const backoff = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * BASE_RETRY_DELAY_MS);
      await sleep(backoff + jitter);
    }
  }
}

/**
 * Resolves after ms milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drains an async run stream into an array, stopping at cap so a busy project or
 * a deep trace never streams more than the caller asked for.
 */
async function drainCapped<T>(
  stream: AsyncIterable<T>,
  cap: number,
): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) {
    items.push(item);
    if (items.length >= cap) {
      break;
    }
  }
  return items;
}
