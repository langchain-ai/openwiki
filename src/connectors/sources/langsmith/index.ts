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
import { compactTrace, summarizeSample } from "./runs.js";
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
 * Cap on traces pulled per project. Within the ingestion window we take the most
 * recent up to this many (each trace is a full tree, so it is the agent's context
 * budget in trace units). Fixed for v1, not configurable.
 */
const MAX_TRACES = 20;

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
    includePayloads: true,
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
 * Pulls one project's latest traces, or undefined when it has none. Throws on
 * API failure so the caller can turn it into a per-project warning.
 */
async function pullProject(
  api: LangSmithApi,
  project: LangSmithProjectConfig,
  apiBaseUrl: string,
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

  return {
    apiBaseUrl,
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
