import { sanitizeDiagnosticText } from "../../../diagnostics.js";
import {
  createRunId,
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
import {
  readLangSmithRepoConfig,
  sanitizeLangSmithApiBaseUrl,
} from "./repo-config.js";
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
 * Cap on traces pulled per project. Within the ingestion window we take the most
 * recent up to this many (each trace is a full tree, so it is the agent's context
 * budget in trace units). Fixed for v1, not configurable.
 */
const MAX_TRACES = 20;

/**
 * Config defaults applied before the user's file and per-run overrides.
 */
const DEFAULT_CONFIG: LangSmithConfig = {
  enabled: false,
  includeFeedback: false,
  includePayloads: false,
  maxFieldChars: 2000,
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
 * Per-run bounds shared by every project pull.
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
 * Loads the effective config for a code-mode run from the repo's committed
 * openwiki/.langsmith.json, or a disabled default when the repo has not configured
 * langsmith (so ingest cleanly skips). Forces includePayloads so full traces land
 * in the ephemeral dump; the committed-wiki privacy rule is enforced by the
 * code-mode guidance, not by dropping payloads here.
 */
async function loadRepoConfig(repoRoot: string): Promise<LangSmithConfig> {
  const repoConfig = await readLangSmithRepoConfig(repoRoot);
  if (!repoConfig || repoConfig.projects.length === 0) {
    return DEFAULT_CONFIG;
  }

  return {
    apiBaseUrl: repoConfig.apiBaseUrl,
    enabled: true,
    includeFeedback: repoConfig.includeFeedback ?? false,
    includePayloads: true,
    maxFieldChars: DEFAULT_CONFIG.maxFieldChars,
    projects: repoConfig.projects,
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
  // langsmith is code-mode only: its config is committed to the repo. Called
  // without a repoRoot (e.g. by the generic ingest-all tool), there is nothing to
  // read, so skip cleanly rather than reaching for a HOME config it never has.
  if (options.repoRoot === undefined) {
    return result(runId, [], [], "skipped", "LangSmith runs in code mode.");
  }

  const config = await loadRepoConfig(options.repoRoot);
  const apiKey = readApiKey();
  const projects = normalizeProjects(config.projects);

  if (!config.enabled) {
    return result(
      runId,
      [],
      [],
      "skipped",
      "LangSmith is not configured for this repository.",
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

  // Re-validate at the SDK boundary: the API key rides along in an Authorization
  // header, so never hand the client a host that is not an official LangSmith one.
  const api = createLangSmithApi(
    sanitizeLangSmithApiBaseUrl(config.apiBaseUrl) ?? DEFAULT_API_BASE_URL,
    apiKey,
  );
  const state = await readConnectorState("langsmith");
  // The window is the ingestion floor; the code-mode caller derives it from the
  // last-update time. Undefined means "no floor" (bootstrap: latest MAX_TRACES).
  const windowStart =
    options.windowHours !== undefined
      ? new Date(
          Date.now() - options.windowHours * 60 * 60 * 1000,
        ).toISOString()
      : undefined;
  const bounds: PullBounds = {
    includeFeedback: config.includeFeedback ?? false,
    includePayloads: config.includePayloads ?? false,
    maxFieldChars: Math.max(100, config.maxFieldChars ?? 2000),
  };

  const warnings: string[] = [];
  const pulls: ProjectPullResult[] = [];

  for (const project of projects) {
    try {
      const pull = await pullProject(api, project, windowStart, bounds);
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
  windowStart: string | undefined,
  bounds: PullBounds,
): Promise<ProjectPullResult | undefined> {
  const { id: projectId, url: projectUrl } = await api.resolveProject(
    project.name,
  );
  const roots = await api.listRecentRootRuns(
    projectId,
    windowStart,
    MAX_TRACES,
  );
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
    .map((project) => ({ name: project.name.trim() }));
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
