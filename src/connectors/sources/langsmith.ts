import { Client, type Run } from "langsmith";

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

type LangSmithConfig = {
  apiBaseUrl?: string;
  enabled?: boolean;
  maxRuns?: number;
  projects?: string[];
};

const DEFAULT_API_BASE_URL = "https://api.smith.langchain.com";
const DEFAULT_MAX_RUNS = 50;
const MAX_FIELD_CHARS = 4000;
const MAX_RUNS = 100;
const STATE_PATH = "~/.openwiki/connectors/langsmith/state.json";

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description: "Fetches recent root traces from LangSmith projects.",
  displayName: "LangSmith",
  id: "langsmith",
  requiredEnv: ["LANGSMITH_API_KEY"],
  supportsAgenticDiscovery: false,
};

export function createLangSmithConnector(): ConnectorRuntime {
  return { ...definition, ingest };
}

async function ingest(
  options: ConnectorIngestOptions = {},
): Promise<ConnectorIngestResult> {
  const runId = createRunId();
  const state = await readConnectorState("langsmith");
  const config = {
    ...(await readConnectorConfig<LangSmithConfig>("langsmith", {
      enabled: false,
      maxRuns: DEFAULT_MAX_RUNS,
      projects: [],
    })),
    ...((options.connectorConfig ?? {}) as LangSmithConfig),
  };
  const apiKey = process.env.LANGSMITH_API_KEY;
  const projects = [
    ...new Set(config.projects?.map((name) => name.trim())),
  ].filter((name): name is string => Boolean(name));
  const warnings: string[] = [];
  const rawFiles: string[] = [];

  if (!config.enabled) {
    return result("skipped", "LangSmith connector is not enabled.");
  }
  if (!apiKey) {
    return result("error", "LANGSMITH_API_KEY is required.");
  }
  if (projects.length === 0) {
    return result("skipped", "Choose at least one LangSmith project.");
  }

  const client = new Client({
    apiKey,
    apiUrl: config.apiBaseUrl ?? DEFAULT_API_BASE_URL,
  });
  const fetchedAt = new Date();
  const windowHours = Math.max(1, Math.min(options.windowHours ?? 24, 168));
  const startTime = new Date(
    fetchedAt.getTime() - windowHours * 60 * 60 * 1000,
  );
  const limit = Math.max(
    1,
    Math.min(options.limit ?? config.maxRuns ?? DEFAULT_MAX_RUNS, MAX_RUNS),
  );
  const projectResults = [];

  for (const project of projects) {
    try {
      const projectRecord = await client.readProject({ projectName: project });
      const projectUrl = await client.getProjectUrl({
        projectId: projectRecord.id,
      });
      const runs = [];

      for await (const run of client.listRuns({
        isRoot: true,
        limit: limit * 2,
        order: "desc",
        projectId: projectRecord.id,
        select: [
          "end_time",
          "error",
          "extra",
          "id",
          "inputs",
          "name",
          "outputs",
          "run_type",
          "start_time",
          "status",
          "tags",
        ],
        startTime,
      })) {
        if (isOpenWikiRun(run) || isAfter(run.start_time, fetchedAt)) {
          continue;
        }
        runs.push(compactRun(run, projectUrl));
        if (runs.length >= limit) {
          break;
        }
      }

      projectResults.push({ project, projectId: projectRecord.id, runs });
    } catch (error) {
      warnings.push(`${project}: ${getErrorMessage(error)}`);
    }
  }

  if (projectResults.length > 0) {
    rawFiles.push(
      await writeRawJson("langsmith", runId, "runs.json", {
        fetchedAt: fetchedAt.toISOString(),
        instanceId: options.instanceId,
        projects: projectResults,
        windowHours,
      }),
    );
  }

  const status = rawFiles.length > 0 ? "success" : "skipped";
  await writeConnectorState(
    "langsmith",
    updateStateWithRun(state, {
      at: fetchedAt.toISOString(),
      rawFiles,
      runId,
      status,
      warnings,
    }),
  );

  return result(
    status,
    `Pulled ${projectResults.length} of ${projects.length} LangSmith project(s).`,
  );

  function result(
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
}

export function isOpenWikiRun(run: Run): boolean {
  const extra: unknown = run.extra;
  const metadata = isRecord(extra) ? extra.metadata : undefined;
  return (
    Boolean(run.tags?.includes("openwiki")) ||
    (isRecord(metadata) && metadata.openwiki === true)
  );
}

export function compactRun(run: Run, projectUrl: string) {
  return {
    endTime: toIso(run.end_time),
    error: truncate(run.error),
    id: run.id,
    inputs: truncate(run.inputs),
    name: run.name,
    outputs: truncate(run.outputs),
    runType: run.run_type,
    startTime: toIso(run.start_time),
    status: run.status,
    traceUrl: `${projectUrl}/r/${run.id}`,
  };
}

function truncate(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > MAX_FIELD_CHARS
    ? `${text.slice(0, MAX_FIELD_CHARS)}…[truncated]`
    : text;
}

function isAfter(value: string | number | undefined, date: Date): boolean {
  return value === undefined || new Date(value).getTime() >= date.getTime();
}

function toIso(value: string | number | undefined): string | undefined {
  return value === undefined ? undefined : new Date(value).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
