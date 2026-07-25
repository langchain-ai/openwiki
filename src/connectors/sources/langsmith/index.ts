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
import type { LangSmithWorkspaceConfig } from "./repo-config.js";
import {
  readLangSmithRepoConfig,
  sanitizeLangSmithApiBaseUrl,
  sanitizeLangSmithApiKeyEnv,
} from "./repo-config.js";
import {
  compactTrace,
  isErrorRun,
  selectSampleBuckets,
  summarizeSample,
} from "./runs.js";
import type { LangSmithProjectConfig, ProjectPullResult } from "./types.js";

/**
 * Default LangSmith API host root; EU workspaces override via apiBaseUrl.
 */
const DEFAULT_API_BASE_URL = "https://api.smith.langchain.com";

/**
 * The primary API-key env var, named in requiredEnv for display. Additional
 * workspaces reference their own OPENWIKI_LANGSMITH_API_KEY_<n> vars.
 */
const PRIMARY_API_KEY_ENV = "OPENWIKI_LANGSMITH_API_KEY";

/**
 * Display path of the connector state file, used in result messages.
 */
const STATE_PATH = "~/.openwiki/connectors/langsmith/state.json";

/**
 * Cap on traces pulled per project. Within the ingestion window we build an
 * anomaly-weighted sample of up to this many (each trace is a full tree, so it is
 * the agent's context budget in trace units). Fixed for v1, not configurable.
 */
const MAX_TRACES = 20;

/**
 * Errors get first claim on the trace budget: the sample is anomaly-weighted so
 * the agent sees failures code review cannot.
 */
const ERROR_CAP = 10;

/**
 * Latency outliers among non-errored runs get the next claim.
 */
const OUTLIER_CAP = 5;

/**
 * Recent lean root runs fetched in ONE unfiltered query, then classified into
 * buckets client-side. Larger than MAX_TRACES so errors and latency outliers are
 * picked from more than the newest few. A server-side error:true query is avoided
 * on purpose: on a busy project it scans history for sparse errors and can exceed
 * the per-request timeout. Only the selected traces are fetched in full.
 */
const SAMPLE_LOOKBACK = 50;

/**
 * Characters kept per free-text field before truncation.
 */
const MAX_FIELD_CHARS = 2000;

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
  requiredEnv: [PRIMARY_API_KEY_ENV],
  supportsAgenticDiscovery: false,
};

/**
 * Per-run bounds shared by every project pull.
 */
interface PullBounds {
  /**
   * Maximum characters kept per free-text field (the truncated error text).
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
 * Loads the committed workspaces for a code-mode run, or an empty list when the
 * repo has not configured langsmith (so ingest cleanly skips). Full trace
 * payloads land in the ephemeral dump; the committed-wiki privacy rule is
 * enforced by the code-mode guidance, not by dropping payloads here.
 */
async function loadWorkspaces(
  repoRoot: string,
): Promise<LangSmithWorkspaceConfig[]> {
  const repoConfig = await readLangSmithRepoConfig(repoRoot);
  return repoConfig?.workspaces ?? [];
}

/**
 * Runs one deterministic LangSmith pull across every configured workspace.
 * Per-workspace (missing key) and per-project (bad name, fetch error) failures
 * become warnings rather than run failures, so one bad entry never blocks the
 * others.
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

  const workspaces = await loadWorkspaces(options.repoRoot);
  if (workspaces.length === 0) {
    return result(
      runId,
      [],
      [],
      "skipped",
      "LangSmith is not configured for this repository.",
    );
  }

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
    maxFieldChars: MAX_FIELD_CHARS,
  };

  const warnings: string[] = [];
  const pulls: ProjectPullResult[] = [];
  let projectCount = 0;

  for (const workspace of workspaces) {
    // Re-validate at the use boundary (parse already allowlisted both): the API
    // key rides along in an Authorization header, so never hand the client a host
    // that is not an official LangSmith one, nor read an env var outside the
    // OpenWiki LangSmith namespace.
    const apiBaseUrl =
      sanitizeLangSmithApiBaseUrl(workspace.apiBaseUrl) ?? DEFAULT_API_BASE_URL;
    const apiKeyEnv = sanitizeLangSmithApiKeyEnv(workspace.apiKeyEnv);
    const projects = normalizeProjects(workspace.projects);
    projectCount += projects.length;

    if (!apiKeyEnv) {
      warnings.push(
        `${sanitizeDiagnosticText(String(workspace.apiKeyEnv))}: not an allowed LangSmith key env var.`,
      );
      continue;
    }
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) {
      // Fail-open: a workspace whose key is absent is a warning, so the other
      // workspaces (and the whole run) still succeed.
      warnings.push(`${apiKeyEnv}: missing key. Add it to ~/.openwiki/.env.`);
      continue;
    }

    const api = createLangSmithApi(apiBaseUrl, apiKey);
    for (const project of projects) {
      try {
        const pull = await pullProject(
          api,
          project,
          apiBaseUrl,
          windowStart,
          bounds,
          warnings,
        );
        if (pull) {
          pulls.push(pull);
        }
      } catch (err) {
        // Fail-open: a bad project name or a fetch error is a warning, never a
        // throw, so the other projects (and the whole run) still succeed.
        warnings.push(
          `${project.name}: ${sanitizeDiagnosticText(errorMessage(err))}`,
        );
      }
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
    `Pulled ${pulls.length} of ${projectCount} LangSmith project(s).`,
  );
}

/**
 * Pulls one project's latest traces, or undefined when it has none. Structural
 * failures (resolve, list) throw so the caller turns them into a per-project
 * warning. A single trace fetch that fails is caught here and recorded as a
 * warning, so one bad trace never sinks the rest of the project's sample. The
 * sample stats are still returned even if every trace fetch fails, since they
 * come from the already-fetched root runs.
 */
async function pullProject(
  api: LangSmithApi,
  project: LangSmithProjectConfig,
  apiBaseUrl: string,
  windowStart: string | undefined,
  bounds: PullBounds,
  warnings: string[],
): Promise<ProjectPullResult | undefined> {
  const { id: projectId, url: projectUrl } = await api.resolveProject(
    project.name,
  );
  // Anomaly-weighted sample within the window: one unfiltered recent batch (fast,
  // no error scan), classified client-side into errors and latency outliers first,
  // then recent baseline runs. Only the chosen traces are fetched in full.
  const recentRoots = await api.listRootRuns(projectId, {
    limit: SAMPLE_LOOKBACK,
    startTime: windowStart,
  });
  const selected = selectSampleBuckets(
    recentRoots.filter(isErrorRun),
    recentRoots.filter((run) => !isErrorRun(run)),
    { errorCap: ERROR_CAP, outlierCap: OUTLIER_CAP, total: MAX_TRACES },
  );
  if (selected.length === 0) {
    return undefined;
  }

  const traces = [];
  for (const { bucket, run } of selected) {
    try {
      const runs = await api.fetchTrace(run.trace_id ?? run.id);
      const trace = compactTrace(
        runs,
        projectUrl,
        bucket,
        bounds.maxFieldChars,
      );
      if (trace) {
        traces.push(trace);
      }
    } catch (err) {
      // Fail-open per trace: a single slow or failed fetch is a warning, not a
      // throw, so the rest of the project's traces (and the run) still succeed.
      warnings.push(
        `${project.name}: skipped a trace: ${sanitizeDiagnosticText(errorMessage(err))}`,
      );
    }
  }
  if (traces.length === 0) {
    return undefined;
  }

  return {
    apiBaseUrl,
    project: project.name,
    projectId,
    stats: summarizeSample(selected),
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
