import {
  createRunId,
  readConnectorConfig,
  readConnectorState,
  updateStateWithRun,
  writeConnectorState,
  writeRawJson,
} from "../../io.js";
import { clampLimit, normalizeWindowHours } from "../../limits.js";
import type {
  ConnectorDefinition,
  ConnectorIngestOptions,
  ConnectorIngestResult,
  ConnectorRuntime,
} from "../../types.js";
import { createLangSmithApi } from "./api.js";
import { compactRun, computeStats, maxStartTime } from "./runs.js";
import type { LangSmithConfig, ProjectPullResult } from "./types.js";

/**
 * Default LangSmith API host root; EU workspaces override via
 * config.apiBaseUrl (e.g. https://eu.api.smith.langchain.com).
 */
const DEFAULT_API_BASE_URL = "https://api.smith.langchain.com";

/**
 * Env var holding the LangSmith API key. Referenced by name, never read into output.
 */
const LANGSMITH_API_KEY_ENV = "LANGSMITH_API_KEY";

/**
 * Display path of the connector state file, used in result messages.
 */
const STATE_PATH = "~/.openwiki/connectors/langsmith/state.json";

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
 * Runs one deterministic LangSmith pull. Per-project failures become
 * warnings rather than run failures, so one bad project name never blocks
 * evidence from the others.
 */
async function ingest(
  options: ConnectorIngestOptions = {},
): Promise<ConnectorIngestResult> {
  const runId = createRunId();
  const config = {
    ...(await readConnectorConfig<LangSmithConfig>("langsmith", {
      enabled: false,
      includeFeedback: false,
      maxErrorRuns: 20,
      maxFieldChars: 2000,
      maxRootRuns: 30,
      projects: [],
    })),
    ...((options.connectorConfig ?? {}) as LangSmithConfig),
  };
  const state = await readConnectorState("langsmith");
  const warnings: string[] = [];
  const rawFiles: string[] = [];

  if (!config.enabled) {
    return {
      connectorId: "langsmith",
      message:
        "LangSmith connector is not enabled. Set enabled=true in ~/.openwiki/connectors/langsmith/config.json.",
      rawFiles,
      runId,
      statePath: STATE_PATH,
      status: "skipped",
      warnings,
    };
  }

  const apiKey = process.env[LANGSMITH_API_KEY_ENV];

  if (!apiKey) {
    return {
      connectorId: "langsmith",
      message: `Missing ${LANGSMITH_API_KEY_ENV}. Add it to ~/.openwiki/.env.`,
      rawFiles,
      runId,
      statePath: STATE_PATH,
      status: "error",
      warnings,
    };
  }

  const projects = [
    ...new Set(
      (config.projects ?? [])
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
    ),
  ];

  if (projects.length === 0) {
    return {
      connectorId: "langsmith",
      message:
        "No LangSmith projects configured. Add projects to ~/.openwiki/connectors/langsmith/config.json.",
      rawFiles,
      runId,
      statePath: STATE_PATH,
      status: "skipped",
      warnings,
    };
  }

  const api = createLangSmithApi(
    config.apiBaseUrl ?? DEFAULT_API_BASE_URL,
    apiKey,
  );
  const windowHours = normalizeWindowHours(options.windowHours);
  const windowEnd = new Date().toISOString();
  const windowStart = new Date(
    Date.now() - windowHours * 60 * 60 * 1000,
  ).toISOString();
  const maxErrorRuns = clampLimit(options.limit, config.maxErrorRuns, 100);
  const maxRootRuns = clampLimit(options.limit, config.maxRootRuns, 100);
  const maxFieldChars = clampLimit(undefined, config.maxFieldChars, 5000);
  const nextCursors: Record<string, string> = {};
  const projectResults: ProjectPullResult[] = [];

  for (const project of projects) {
    try {
      // The cursor keeps overlapping daily windows from refetching runs the
      // agent has already synthesized into the wiki.
      const cursor = state.latestIds?.[cursorKey(project)];
      const startTime = cursor && cursor > windowStart ? cursor : windowStart;
      const { id: projectId, url: projectUrl } =
        await api.resolveProject(project);
      const recentRuns = await api.queryRootRuns(projectId, {
        endTime: windowEnd,
        errorOnly: false,
        limit: maxRootRuns,
        startTime,
      });
      const errorRuns = recentRuns
        .filter((run) => run.status === "error" || run.error != null)
        .slice(0, maxErrorRuns);
      const feedback = config.includeFeedback
        ? await api.fetchFeedback(errorRuns.map((run) => run.id))
        : [];

      // Runs are fetched oldest-first. Advancing the cursor to this batch's
      // newest run lets a later ingestion continue through a busy window.
      if (recentRuns.length === maxRootRuns) {
        warnings.push(
          `${project}: hit the per-run fetch limit (${recentRuns.length}/${maxRootRuns}); remaining runs will be processed on a later ingestion.`,
        );
      }

      projectResults.push({
        errorRuns: errorRuns.map((run) =>
          compactRun(run, projectUrl, maxFieldChars),
        ),
        feedback,
        project,
        projectId,
        recentRuns: recentRuns.map((run) =>
          compactRun(run, projectUrl, maxFieldChars),
        ),
        stats: computeStats(recentRuns),
      });

      const latestStart = maxStartTime([...recentRuns, ...errorRuns]);

      if (latestStart) {
        nextCursors[cursorKey(project)] = latestStart;
      }
    } catch (error) {
      warnings.push(`${project}: ${getErrorMessage(error)}`);
    }
  }

  if (projectResults.length > 0) {
    rawFiles.push(
      await writeRawJson("langsmith", runId, "langsmith-results.json", {
        fetchedAt: windowEnd,
        instanceId: options.instanceId,
        projects: projectResults,
        windowHours,
      }),
    );
  }

  const status = rawFiles.length > 0 ? "success" : "skipped";
  const nextState = updateStateWithRun(state, {
    at: new Date().toISOString(),
    rawFiles,
    runId,
    status,
    warnings,
  });
  nextState.latestIds = {
    ...(nextState.latestIds ?? {}),
    ...nextCursors,
  };
  await writeConnectorState("langsmith", nextState);

  return {
    connectorId: "langsmith",
    message: `Pulled ${projectResults.length} of ${projects.length} LangSmith project(s).`,
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
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
