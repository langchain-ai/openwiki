import { Client } from "langsmith";
import type { Feedback, Run } from "langsmith";

/**
 * Maximum error runs for which feedback is fetched in one ingestion run.
 */
const MAX_FEEDBACK_RUNS = 20;

/**
 * Maximum feedback entries fetched per error run.
 */
const MAX_FEEDBACK_PER_RUN = 5;

/**
 * Fields requested via the SDK's listRuns `select` option. Keeping this list
 * explicit is the first line of volume control: fields not listed here never
 * leave LangSmith.
 */
const RUN_SELECT_FIELDS = [
  "end_time",
  "error",
  "id",
  "inputs",
  "name",
  "outputs",
  "run_type",
  "start_time",
  "status",
  "total_tokens",
];

/**
 * Parameters for a root-run query against one project.
 */
export interface RootRunQuery {
  /**
   * When true, only failed runs are returned.
   */
  errorOnly: boolean;

  /**
   * Maximum number of runs to return.
   */
  limit: number;

  /**
   * ISO timestamp; only runs starting at or after this instant match.
   */
  startTime: string;
}

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
   * Fetches recent feedback entries for the given run ids, bounded per run.
   */
  fetchFeedback(runIds: string[]): Promise<Feedback[]>;

  /**
   * Lists project (tracing session) names visible to the API key, sorted, for
   * the onboarding picker.
   */
  listProjectNames(): Promise<string[]>;

  /**
   * Queries root runs for one project since a start time, newest first.
   */
  queryRootRuns(projectId: string, query: RootRunQuery): Promise<Run[]>;

  /**
   * Resolves a project (tracing session) name to its UUID and URL base.
   */
  resolveProject(name: string): Promise<ResolvedProject>;
}

/**
 * Creates a LangSmith API wrapper bound to one base URL and API key. The key
 * is handed to the SDK Client and never stored on the returned object, so it
 * cannot leak through logging or serialization of the wrapper.
 */
export function createLangSmithApi(
  baseUrl: string,
  apiKey: string,
): LangSmithApi {
  const client = new Client({ apiKey, apiUrl: baseUrl });

  return {
    async fetchFeedback(runIds) {
      const feedback: Feedback[] = [];
      const maxEntries = MAX_FEEDBACK_RUNS * MAX_FEEDBACK_PER_RUN;

      // listFeedback streams lazily; cap the total so a heavily-annotated set
      // of error runs cannot flood the pull.
      for await (const entry of client.listFeedback({
        runIds: runIds.slice(0, MAX_FEEDBACK_RUNS),
      })) {
        feedback.push(entry);
        if (feedback.length >= maxEntries) {
          break;
        }
      }

      return feedback;
    },

    async listProjectNames() {
      const names: string[] = [];
      for await (const project of client.listProjects()) {
        if (project.name) {
          names.push(project.name);
        }
      }
      return names.sort();
    },

    async queryRootRuns(projectId, { errorOnly, limit, startTime }) {
      const runs: Run[] = [];

      for await (const run of client.listRuns({
        ...(errorOnly ? { error: true } : {}),
        isRoot: true,
        limit,
        projectId,
        select: RUN_SELECT_FIELDS,
        startTime: new Date(startTime),
      })) {
        runs.push(run);

        // listRuns paginates lazily; stop at the bound so a busy project never
        // streams more than the caller asked for.
        if (runs.length >= limit) {
          break;
        }
      }

      return runs;
    },

    async resolveProject(name) {
      const project = await client.readProject({ projectName: name });
      const url = await client.getProjectUrl({ projectId: project.id });
      return { id: project.id, url };
    },
  };
}
