import { sanitizeDiagnosticText } from "../../../diagnostics.js";
import {
  createRunId,
  readConnectorConfig,
  readConnectorState,
  updateStateWithRun,
  writeConnectorState,
  writeRawJson,
} from "../../io.js";
import { clampLimit, normalizeWindowHours } from "./limits.js";
import type {
  ConnectorDefinition,
  ConnectorIngestOptions,
  ConnectorIngestResult,
  ConnectorRuntime,
} from "../../types.js";
import type { LangSmithApi } from "./api.js";
import { createLangSmithApi } from "./api.js";
import { compactRun, computeStats, maxStartTime } from "./runs.js";
import type {
  CompactRun,
  LangSmithConfig,
  ProjectPullResult,
} from "./types.js";
import type { Run } from "langsmith";

/**
 * Default LangSmith API host root; EU workspaces override via config.apiBaseUrl.
 */
const DEFAULT_API_BASE_URL = "https://api.smith.langchain.com";

/**
 * Env var holding the LangSmith API key. Referenced by name, never read into
 * output.
 */
const LANGSMITH_API_KEY_ENV = "OPENWIKI_LANGSMITH_API_KEY";

/**
 * Display path of the connector state file, used in result messages.
 */
const STATE_PATH = "~/.openwiki/connectors/langsmith/state.json";

/**
 * Config defaults applied before the user's file and per-run overrides.
 */
const DEFAULT_CONFIG: LangSmithConfig = {
  enabled: false,
  includeFeedback: false,
  includePayloads: false,
  maxErrorRuns: 20,
  maxFieldChars: 2000,
  maxRootRuns: 30,
  projects: [],
};

/**
 * Static connector definition registered with the connector registry.
 */
const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Fetches recent LangSmith root runs, errors, and computed stats through the official LangSmith SDK.",
  displayName: "LangSmith",
  id: "langsmith",
  requiredEnv: [LANGSMITH_API_KEY_ENV],
  supportsAgenticDiscovery: false,
};

/**
 * Builds the LangSmith connector runtime for the connector registry.
 */
export function createLangSmithConnector(): ConnectorRuntime {
  return {
    ...definition,
    ingest,
  };
}

/**
 * Reads the LangSmith API key, preferring the OpenWiki-scoped var and falling
 * back to the ecosystem-standard LANGSMITH_API_KEY the tracing setup already
 * sets.
 */
function readApiKey(): string | undefined {
  return process.env[LANGSMITH_API_KEY_ENV] ?? process.env.LANGSMITH_API_KEY;
}

/**
 * Per-run fetch bounds shared by every project pull.
 */
interface PullBounds {
  /**
   * Fetch feedback for the error runs.
   */
  includeFeedback: boolean;

  /**
   * Include raw inputs/outputs in the compacted runs.
   */
  includePayloads: boolean;

  /**
   * Maximum failed root runs to fetch.
   */
  maxErrorRuns: number;

  /**
   * Maximum characters kept per free-text field.
   */
  maxFieldChars: number;

  /**
   * Maximum recent root runs to fetch.
   */
  maxRootRuns: number;
}

/**
 * One project's compacted pull plus the cursor to persist and any warning.
 */
interface ProjectPull {
  /**
   * Latest run start time seen, stored so the next run skips it.
   */
  cursor?: string;

  /**
   * Compacted runs, feedback, and stats for the project.
   */
  result: ProjectPullResult;

  /**
   * Saturation notice when the window held more runs than were fetched.
   */
  warning?: string;
}

/**
 * Runs one deterministic LangSmith pull. Per-project failures become warnings
 * rather than run failures, so one bad project name never blocks evidence from
 * the others.
 */
async function ingest(
  options: ConnectorIngestOptions = {},
): Promise<ConnectorIngestResult> {
  const runId = createRunId();
  const config = {
    ...(await readConnectorConfig<LangSmithConfig>(
      "langsmith",
      DEFAULT_CONFIG,
    )),
    ...((options.connectorConfig ?? {}) as LangSmithConfig),
  };
  const apiKey = readApiKey();
  const projects = (config.projects ?? []).filter(
    (name) => name.trim().length > 0,
  );

  if (!config.enabled) {
    return result(
      runId,
      [],
      [],
      "skipped",
      "LangSmith connector is not enabled.",
    );
  }

  if (!apiKey) {
    return result(
      runId,
      [],
      [],
      "error",
      `Missing ${LANGSMITH_API_KEY_ENV}. Add it to ~/.openwiki/.env`,
    );
  }

  if (projects.length === 0) {
    return result(
      runId,
      [],
      [],
      "skipped",
      "No LangSmith projects configured.",
    );
  }

  const api = createLangSmithApi(
    config.apiBaseUrl ?? DEFAULT_API_BASE_URL,
    apiKey,
  );
  const state = await readConnectorState("langsmith");
  const windowHours = normalizeWindowHours(options.windowHours);
  const windowStart = new Date(
    Date.now() - windowHours * 60 * 60 * 1000,
  ).toISOString();
  const bounds: PullBounds = {
    includeFeedback: config.includeFeedback ?? false,
    includePayloads: config.includePayloads ?? false,
    maxErrorRuns: clampLimit(options.limit, config.maxErrorRuns, 100),
    maxFieldChars: Math.max(100, config.maxFieldChars ?? 2000),
    maxRootRuns: clampLimit(options.limit, config.maxRootRuns, 100),
  };

  const warnings: string[] = [];
  const cursors: Record<string, string> = {};
  const pulls: ProjectPullResult[] = [];

  for (const project of projects) {
    const cursor = state.latestIds?.[cursorKey(project)];
    const startTime = cursor && cursor > windowStart ? cursor : windowStart;
    try {
      const pull = await pullProject(api, project, startTime, bounds);
      pulls.push(pull.result);

      if (pull.cursor) {
        cursors[cursorKey(project)] = pull.cursor;
      }

      if (pull.warning) {
        warnings.push(pull.warning);
      }
    } catch (err) {
      const message = errorMessage(err);
      warnings.push(`${project}: ${sanitizeDiagnosticText(message)}`);
    }
  }

  const rawFiles =
    pulls.length > 0
      ? [
          await writeRawJson("langsmith", runId, "langsmith-results.json", {
            fetchedAt: new Date().toISOString(),
            instanceId: options.instanceId,
            projects: pulls,
            windowHours,
          }),
        ]
      : [];
  const status = rawFiles.length > 0 ? "success" : "skipped";
  const nextState = updateStateWithRun(state, {
    at: new Date().toISOString(),
    rawFiles,
    runId,
    status,
    warnings,
  });
  nextState.latestIds = { ...(nextState.latestIds ?? {}), ...cursors };
  await writeConnectorState("langsmith", nextState);

  return result(
    runId,
    warnings,
    rawFiles,
    status,
    `Pulled ${pulls.length} of ${projects.length} LangSmith project(s).`,
  );
}

/**
 * Fetches, bounds, and compacts one project's runs. Throws on API failure so
 * the caller can turn it into a per-project warning.
 */
async function pullProject(
  api: LangSmithApi,
  project: string,
  startTime: string,
  bounds: PullBounds,
): Promise<ProjectPull> {
  const { id: projectId, url: projectUrl } = await api.resolveProject(project);
  const errorRuns = await api.queryRootRuns(projectId, {
    errorOnly: true,
    limit: bounds.maxErrorRuns,
    startTime,
  });
  const recentRuns = await api.queryRootRuns(projectId, {
    errorOnly: false,
    limit: bounds.maxRootRuns,
    startTime,
  });
  const feedback = bounds.includeFeedback
    ? await api.fetchFeedback(errorRuns.map((run) => run.id))
    : [];
  const compact = (run: Run): CompactRun =>
    compactRun(run, projectUrl, bounds.maxFieldChars, bounds.includePayloads);

  // A saturated query means the window held more runs than we fetched; surface
  // it rather than undersampling silently.
  const saturated =
    errorRuns.length === bounds.maxErrorRuns ||
    recentRuns.length === bounds.maxRootRuns;

  return {
    cursor: maxStartTime([...recentRuns, ...errorRuns]),
    result: {
      errorRuns: errorRuns.map(compact),
      feedback,
      project,
      projectId,
      recentRuns: recentRuns.map(compact),
      stats: computeStats(recentRuns),
    },
    warning: saturated
      ? `${project}: hit the per-run fetch limit; older runs in this window were not sampled.`
      : undefined,
  };
}

/**
 * Builds a ConnectorIngestResult with the fixed connector id and state path.
 */
function result(
  runId: string,
  warnings: string[],
  rawFiles: string[],
  status: ConnectorIngestResult["status"],
  message: string,
): ConnectorIngestResult {
  return {
    connectorId: "langsmith",
    message,
    rawFiles,
    runId,
    statePath: STATE_PATH,
    status,
    warnings,
  };
}

/**
 * State key under which one project's last-seen run start time is stored.
 */
function cursorKey(project: string): string {
  return `project:${project}:lastRunStart`;
}

/**
 * Normalizes unknown thrown values into a printable message.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
