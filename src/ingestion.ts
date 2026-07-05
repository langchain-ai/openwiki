import {
  createConnectorRegistry,
  isConnectorId,
} from "./connectors/registry.js";
import type {
  ConnectorId,
  ConnectorIngestResult,
  ConnectorRuntime,
} from "./connectors/types.js";
import { loadOpenWikiEnv } from "./env.js";
import {
  readOpenWikiOnboardingConfig,
  type OnboardingSourceInstanceConfig,
  type OpenWikiOnboardingConfig,
} from "./onboarding.js";
import {
  ensureOpenWikiHome,
  getConnectorConfigPath,
  openWikiLocalWikiDir,
} from "./openwiki-home.js";
import { createOpenWikiThreadId, runOpenWikiAgent } from "./agent/index.js";
import type {
  OpenWikiRunEvent,
  OpenWikiRunOptions,
  OpenWikiRunResult,
} from "./agent/types.js";

const INGESTION_WINDOW_HOURS = 24;

export type IngestionTarget = ConnectorId | "all" | SourceInstanceTarget;

export type SourceInstanceTarget = {
  kind: "source-instance";
  id: string;
};

export type SourceIngestionResult = {
  agentResult?: OpenWikiRunResult;
  connectorId: ConnectorId;
  deterministicPull?: ConnectorIngestResult;
  displayName: string;
  rawFiles: string[];
  sourceInstanceId: string;
  status: "agent-updated" | "error" | "skipped";
};

export type OpenWikiIngestionResult = {
  results: SourceIngestionResult[];
};

export type OpenWikiIngestionOptions = Pick<
  OpenWikiRunOptions,
  "debug" | "modelId" | "onEvent"
> & {
  scheduledOnly?: boolean;
  target: IngestionTarget;
};

export async function runOpenWikiIngestion(
  _cwd = process.cwd(),
  options: OpenWikiIngestionOptions,
): Promise<OpenWikiIngestionResult> {
  void _cwd;
  await loadOpenWikiEnv();
  await ensureOpenWikiHome();
  const config = await readOpenWikiOnboardingConfig();
  const registry = createConnectorRegistry();
  const sourceInstances = resolveIngestionSourceInstances(
    options.target,
    config,
    {
      scheduledOnly: options.scheduledOnly ?? false,
    },
  );
  const results: SourceIngestionResult[] = [];

  if (options.target !== "all" && sourceInstances.length === 0) {
    throw new Error(
      `No configured ingestion source matched ${formatTarget(options.target)}.`,
    );
  }

  for (const sourceConfig of sourceInstances) {
    const connector = registry[sourceConfig.connectorId];

    results.push(
      await runSourceIngestion({
        config,
        connector,
        cwd: openWikiLocalWikiDir,
        emit: options.onEvent,
        modelId: options.modelId,
        sourceConfig,
      }),
    );
  }

  return { results };
}

export function parseIngestionTarget(value: string): IngestionTarget | null {
  if (value === "all") {
    return "all";
  }

  if (isConnectorId(value)) {
    return value;
  }

  return isSafeSourceInstanceId(value)
    ? {
        kind: "source-instance",
        id: value,
      }
    : null;
}

async function runSourceIngestion({
  config,
  connector,
  cwd,
  emit,
  modelId,
  sourceConfig,
}: {
  config: OpenWikiOnboardingConfig;
  connector: ConnectorRuntime;
  cwd: string;
  emit?: (event: OpenWikiRunEvent) => void;
  modelId?: string | null;
  sourceConfig: OnboardingSourceInstanceConfig;
}): Promise<SourceIngestionResult> {
  emitText(
    emit,
    `\nStarting ${getSourceDisplayName(connector, sourceConfig)} ingestion.\n`,
  );

  try {
    const deterministicPull = isDeterministicConnector(connector)
      ? await connector.ingest({
          connectorConfig: sourceConfig.connectorConfig,
          instanceId: sourceConfig.id,
          windowHours: INGESTION_WINDOW_HOURS,
        })
      : undefined;
    const rawFiles = deterministicPull?.rawFiles ?? [];

    if (
      deterministicPull &&
      deterministicPull.status === "error" &&
      rawFiles.length === 0
    ) {
      emitText(
        emit,
        `${connector.displayName} deterministic pull failed: ${deterministicPull.message}\n`,
      );
      return {
        connectorId: connector.id,
        deterministicPull,
        displayName: getSourceDisplayName(connector, sourceConfig),
        rawFiles,
        sourceInstanceId: sourceConfig.id,
        status: "error",
      };
    }

    emitDeterministicPullSummary(emit, deterministicPull);

    const agentResult = await runOpenWikiAgent("update", cwd, {
      isFollowup: false,
      modelId,
      onEvent: emit,
      outputMode: "local-wiki",
      threadId: createOpenWikiThreadId(cwd),
      userMessage: createSourceUpdateMessage({
        config,
        connector,
        deterministicPull,
        rawFiles,
        sourceConfig,
      }),
    });

    return {
      agentResult,
      connectorId: connector.id,
      deterministicPull,
      displayName: getSourceDisplayName(connector, sourceConfig),
      rawFiles,
      sourceInstanceId: sourceConfig.id,
      status: "agent-updated",
    };
  } catch (error) {
    const message = getErrorMessage(error);
    emitText(emit, `${connector.displayName} ingestion failed: ${message}\n`);
    return {
      connectorId: connector.id,
      displayName: getSourceDisplayName(connector, sourceConfig),
      rawFiles: [],
      sourceInstanceId: sourceConfig.id,
      status: "error",
    };
  }
}

function resolveIngestionSourceInstances(
  target: IngestionTarget,
  config: OpenWikiOnboardingConfig,
  { scheduledOnly }: { scheduledOnly: boolean },
): OnboardingSourceInstanceConfig[] {
  return config.sourceInstances.filter((sourceConfig) => {
    if (!sourceConfig.connectedAt || !isConnectorId(sourceConfig.connectorId)) {
      return false;
    }

    if (
      scheduledOnly &&
      (!config.ingestionSchedule || config.ingestionSchedule.pausedAt)
    ) {
      return false;
    }

    if (target === "all") {
      return true;
    }

    if (typeof target === "string") {
      return sourceConfig.connectorId === target;
    }

    return sourceConfig.id === target.id;
  });
}

function isSafeSourceInstanceId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(value);
}

function formatTarget(target: IngestionTarget): string {
  return typeof target === "object" ? target.id : target;
}

function getSourceDisplayName(
  connector: ConnectorRuntime,
  sourceConfig: OnboardingSourceInstanceConfig,
): string {
  return sourceConfig.name ?? connector.displayName;
}

function isDeterministicConnector(connector: ConnectorRuntime): boolean {
  return !connector.supportsAgenticDiscovery;
}

function createSourceUpdateMessage({
  config,
  connector,
  deterministicPull,
  rawFiles,
  sourceConfig,
}: {
  config: OpenWikiOnboardingConfig;
  connector: ConnectorRuntime;
  deterministicPull: ConnectorIngestResult | undefined;
  rawFiles: string[];
  sourceConfig: OnboardingSourceInstanceConfig;
}): string {
  const ingestionGoal = sourceConfig.ingestionGoal?.trim();
  const wikiGoal = config.wikiGoal?.trim();

  if (deterministicPull) {
    return `
Run an OpenWiki source update for ${getSourceDisplayName(connector, sourceConfig)} (${connector.id}).

Scope:
- This is one source-specific ingestion run.
- Source instance: ${sourceConfig.id}${sourceConfig.name ? ` (${sourceConfig.name})` : ""}.
- Use the last ${INGESTION_WINDOW_HOURS} hours of newly pulled data for this source.
- Update the wiki only with information relevant to this source and the user's goals.

User wiki goal:
${wikiGoal || "(not provided)"}

Source-specific instructions:
${ingestionGoal || "(not provided)"}

Deterministic pull result:
- Status: ${deterministicPull.status}
- Message: ${deterministicPull.message}
- Raw data files:
${formatRawFileList(rawFiles)}

Instructions:
- Read the raw data files above before updating the wiki.
- These paths are host filesystem paths under ~/.openwiki. Do not pass them to virtual filesystem tools. Use shell commands such as cat, jq, or node from the local wiki root if you need to inspect them.
- Summarize, merge, and deduplicate the new source data into the local OpenWiki docs under ~/.openwiki/wiki. Filesystem tools are rooted at that wiki directory, so write pages directly under /, such as /quickstart.md or /sources/${connector.id}.md. Do not create a nested /openwiki directory.
- Do not run other source ingestions in this run.
`.trim();
  }

  return `
Run an OpenWiki source update for ${getSourceDisplayName(connector, sourceConfig)} (${connector.id}).

Scope:
- This is one source-specific ingestion run.
- Source instance: ${sourceConfig.id}${sourceConfig.name ? ` (${sourceConfig.name})` : ""}.
- Ingest relevant information from this provider over the last ${INGESTION_WINDOW_HOURS} hours.
- This source cannot be fully pulled deterministically before the agent run, so use available OpenWiki connector tools, MCP tools, local repository inspection, and source config as needed.

User wiki goal:
${wikiGoal || "(not provided)"}

Source-specific instructions:
${ingestionGoal || "(not provided)"}

Source config:
- Connector config path: ${getConnectorConfigPath(connector.id)}

Instructions:
- Gather only data relevant to this source and the last ${INGESTION_WINDOW_HOURS} hours.
- Update the local OpenWiki docs under ~/.openwiki/wiki with the relevant findings. Filesystem tools are rooted at that wiki directory, so write pages directly under /, such as /quickstart.md or /sources/${connector.id}.md. Do not create a nested /openwiki directory.
- Do not run other source ingestions in this run.
`.trim();
}

function emitDeterministicPullSummary(
  emit: ((event: OpenWikiRunEvent) => void) | undefined,
  deterministicPull: ConnectorIngestResult | undefined,
): void {
  if (!deterministicPull) {
    return;
  }

  emitText(
    emit,
    `${deterministicPull.message} Raw files: ${
      deterministicPull.rawFiles.length > 0
        ? deterministicPull.rawFiles.join(", ")
        : "none"
    }\n`,
  );
}

function emitText(
  emit: ((event: OpenWikiRunEvent) => void) | undefined,
  text: string,
): void {
  emit?.({
    source: "main",
    text,
    type: "text",
  });
}

function formatRawFileList(rawFiles: string[]): string {
  if (rawFiles.length === 0) {
    return "- (no raw files written)";
  }

  return rawFiles.map((filePath) => `- ${filePath}`).join("\n");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
