import { sanitizeDiagnosticText } from "../../../diagnostics.js";
import {
  createRunId,
  readConnectorConfig,
  readConnectorState,
  updateStateWithRun,
  writeConnectorState,
  writeRawJson,
} from "../../io.js";
import type {
  ConnectorDefinition,
  ConnectorIngestOptions,
  ConnectorIngestResult,
  ConnectorRuntime,
} from "../../types.js";
import type { LangSmithApi } from "./api.js";
import { createLangSmithApi } from "./api.js";
import { clampTraces } from "./limits.js";
import { compactTrace, summarizeSample } from "./runs.js";
import type {
  LangSmithConfig,
  LangSmithProjectConfig,
  ProjectPullResult,
} from "./types.js";

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
  maxFieldChars: 2000,
  maxTraces: 10,
  projects: [],
};

/**
 * Static connector definition registered with the connector registry.
 */
const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Pulls recent LangSmith traces (tool calls, outcomes, latency) through the official LangSmith SDK.",
  displayName: "LangSmith",
  id: "langsmith",
  mode: "code",
  requiredEnv: [LANGSMITH_API_KEY_ENV],
  supportsAgenticDiscovery: false,
};

/**
 * Per-run bounds shared by every project pull (maxTraces is resolved per project).
 */
interface PullBounds {
  /**
   * Fetch feedback for the pulled traces.
   */
  includeFeedback: boolean;

  /**
   * Include truncated inputs/outputs in the compacted trace runs.
   */
  includePayloads: boolean;

  /**
   * Maximum characters kept per free-text field.
   */
  maxFieldChars: number;
}

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
 * back to the ecosystem-standard LANGSMITH_API_KEY. Shell-vs-file precedence is
 * decided by loadOpenWikiEnv (which only fills a key the shell left unset), so by
 * the time this runs process.env already holds "shell over ~/.openwiki/.env".
 */
function readApiKey(): string | undefined {
  return process.env[LANGSMITH_API_KEY_ENV] ?? process.env.LANGSMITH_API_KEY;
}

/**
 * Runs one deterministic LangSmith pull. Per-project failures become warnings
 * rather than run failures, so one bad project name never blocks the others.
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
  const projects = normalizeProjects(config.projects);

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
      `Missing ${LANGSMITH_API_KEY_ENV}. Add it to ~/.openwiki/.env.`,
    );
  }

  if (projects.length === 0) {
    return result(runId, [], [], "skipped", "No LangSmith projects configured");
  }

  const api = createLangSmithApi(
    config.apiBaseUrl ?? DEFAULT_API_BASE_URL,
    apiKey,
  );
  const state = await readConnectorState("langsmith");
  const defaultMaxTraces = config.maxTraces ?? 10;
  const bounds: PullBounds = {
    includeFeedback: config.includeFeedback ?? false,
    includePayloads: config.includePayloads ?? false,
    maxFieldChars: Math.max(100, config.maxFieldChars ?? 2000),
  };

  const warnings: string[] = [];
  const pulls: ProjectPullResult[] = [];

  for (const project of projects) {
    const maxTraces = clampTraces(project.maxTraces, defaultMaxTraces);

    try {
      const pull = await pullProject(api, project, maxTraces, bounds);
      if (pull) {
        pulls.push(pull);
      }
    } catch (err) {
      warnings.push(
        `${project.name}: ${sanitizeDiagnosticText(errorMessage(err))}`,
      );
    }
  }

  const rawFiles =
    pulls.length > 0
      ? [
          await writeRawJson("langsmith", runId, "langsmith-results.json", {
            fetchedAt: new Date().toISOString(),
            instanceId: options.instanceId,
            projects: pulls,
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
 * Pulls one project's latest traces, or undefined when it has none. Throws on
 * API failure so the caller can turn it into a per-project warning.
 */
async function pullProject(
  api: LangSmithApi,
  project: LangSmithProjectConfig,
  maxTraces: number,
  bounds: PullBounds,
): Promise<ProjectPullResult | undefined> {
  const { id: projectId, url: projectUrl } = await api.resolveProject(
    project.name,
  );
  const roots = await api.listRecentRootRuns(projectId, maxTraces);
  if (roots.length === 0) {
    return undefined;
  }

  const traces = [];
  for (const root of roots) {
    const runs = await api.fetchTrace(root.trace_id ?? root.id);
    const trace = compactTrace(
      runs,
      projectUrl,
      bounds.maxFieldChars,
      bounds.includePayloads,
    );
    if (trace) {
      traces.push(trace);
    }
  }

  const feedback = bounds.includeFeedback
    ? await api.fetchFeedback(roots.map((run) => run.id))
    : [];

  return {
    feedback,
    project: project.name,
    projectId,
    stats: summarizeSample(roots),
    traces,
  };
}

/**
 * Filters config projects to entries with a usable name, trimming names.
 */
function normalizeProjects(
  projects: LangSmithProjectConfig[] | undefined,
): LangSmithProjectConfig[] {
  return (projects ?? [])
    .filter(
      (project): project is LangSmithProjectConfig =>
        typeof project?.name === "string" && project.name.trim().length > 0,
    )
    .map((project) => ({
      maxTraces: project.maxTraces,
      name: project.name.trim(),
    }));
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
 * Normalizes unknown thrown values into a printable message.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
