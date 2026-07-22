import { Client } from "langsmith";
import type { Feedback, Run } from "langsmith";

/**
 * Fields requested for the trace-tree fetch. Explicit so fields we do not list
 * never leave LangSmith, and so tree structure (parent/trace ids, run type) and
 * payloads are available for compaction.
 */
const RUN_SELECT_FIELDS = [
  "end_time",
  "error",
  "id",
  "inputs",
  "name",
  "outputs",
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
 * Feedback entries fetched per pull, total.
 */
const MAX_FEEDBACK = 100;

/**
 * Runs fetched per trace tree; a backstop against a pathological deep trace.
 */
const MAX_TRACE_RUNS = 500;

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
   * The most-recent root runs (newest first, capped at limit) since startTime, or
   * with no lower bound when startTime is undefined. Used to pick the latest trace
   * ids and to summarize the sample.
   */
  listRecentRootRuns(
    projectId: string,
    startTime: string | undefined,
    limit: number,
  ): Promise<Run[]>;

  /**
   * All runs in one trace (root plus descendants), for full-tree compaction.
   */
  fetchTrace(traceId: string): Promise<Run[]>;

  /**
   * Recent feedback entries for the given run ids, bounded.
   */
  fetchFeedback(runIds: string[]): Promise<Feedback[]>;

  /**
   * Project (tracing session) names visible to the key, sorted. Filtered
   * server-side by a name substring and capped so the setup picker stays fast on
   * workspaces with thousands of projects.
   */
  listProjectNames(options?: {
    limit?: number;
    nameContains?: string;
  }): Promise<string[]>;
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
  const client = new Client({ apiKey, apiUrl: baseUrl });

  return {
    async resolveProject(name) {
      const project = await client.readProject({ projectName: name });
      const url = await client.getProjectUrl({ projectId: project.id });
      return { id: project.id, url };
    },

    async listRecentRootRuns(projectId, startTime, limit) {
      return drainCapped(
        client.listRuns({
          isRoot: true,
          limit,
          projectId,
          select: ROOT_SELECT_FIELDS,
          ...(startTime ? { startTime: new Date(startTime) } : {}),
        }),
        limit,
      );
    },

    async fetchTrace(traceId) {
      return drainCapped(
        client.listRuns({ select: RUN_SELECT_FIELDS, traceId }),
        MAX_TRACE_RUNS,
      );
    },

    async fetchFeedback(runIds) {
      return drainCapped(client.listFeedback({ runIds }), MAX_FEEDBACK);
    },

    async listProjectNames(options = {}) {
      // includeStats:false skips per-project run aggregates (the slow part).
      // nameContains filters server-side so a huge workspace never enumerates
      // every project; limit bounds the returned page.
      const names: string[] = [];
      for await (const project of client.listProjects({
        includeStats: false,
        ...(options.nameContains ? { nameContains: options.nameContains } : {}),
      })) {
        if (project.name) {
          names.push(project.name);
        }
        if (options.limit !== undefined && names.length >= options.limit) {
          break;
        }
      }
      return names.sort();
    },
  };
}

/**
 * Drains an async run/feedback stream into an array, stopping at cap so a busy
 * project or a deep trace never streams more than the caller asked for.
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
