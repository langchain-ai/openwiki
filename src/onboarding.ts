import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { OPEN_WIKI_DIR } from "./constants.js";
import { ensureOpenWikiHome, openWikiHomeDir } from "./openwiki-home.js";
import type { ConnectorId } from "./connectors/types.js";

export const openWikiOnboardingPath = path.join(
  openWikiHomeDir,
  "onboarding.json",
);
export const openWikiInstructionsPath = path.join(
  openWikiHomeDir,
  "INSTRUCTIONS.md",
);
export const REPOSITORY_INSTRUCTIONS_FILE = "INSTRUCTIONS.md";

export type OnboardingSourceScheduleConfig = {
  description: string;
  expression: string;
  launchAgentPath?: string;
  pausedAt?: string;
  updatedAt: string;
  warning?: string;
};

export type OnboardingSourceConfig = {
  connectedAt?: string;
  connectorConfig?: Record<string, unknown>;
  ingestionGoal?: string;
  schedule?: OnboardingSourceScheduleConfig;
};

export type OnboardingSourceInstanceConfig = OnboardingSourceConfig & {
  connectorId: ConnectorId;
  id: string;
  name?: string;
};

export type OpenWikiPowerManagementConfig = {
  pmset?: {
    days: string;
    enabled: boolean;
    sleepTime: string;
    updatedAt: string;
    wakeTime: string;
    warning?: string;
  };
};

export type OpenWikiOnboardingConfig = {
  completedAt?: string;
  ingestionSchedule?: OnboardingSourceScheduleConfig;
  modeId?: string;
  modeName?: string;
  powerManagement?: OpenWikiPowerManagementConfig;
  sourceInstances: OnboardingSourceInstanceConfig[];
  sources: Partial<Record<ConnectorId, OnboardingSourceConfig>>;
  templateId?: string;
  templateName?: string;
  version: 1;
  wikiGoal?: string;
};

export function createEmptyOnboardingConfig(): OpenWikiOnboardingConfig {
  return {
    sourceInstances: [],
    sources: {},
    version: 1,
  };
}

export async function readOpenWikiOnboardingConfig(): Promise<OpenWikiOnboardingConfig> {
  await ensureOpenWikiHome();

  try {
    const config = normalizeOnboardingConfig(
      JSON.parse(await readFile(openWikiOnboardingPath, "utf8")),
    );

    return {
      ...config,
      wikiGoal: await readWikiInstructions(),
    };
  } catch (error) {
    if (isFileNotFoundError(error)) {
      const wikiGoal = await readWikiInstructions();
      return wikiGoal
        ? { ...createEmptyOnboardingConfig(), wikiGoal }
        : createEmptyOnboardingConfig();
    }

    throw error;
  }
}

export async function saveOpenWikiOnboardingConfig(
  config: OpenWikiOnboardingConfig,
): Promise<void> {
  await ensureOpenWikiHome();
  const normalizedConfig = normalizeOnboardingConfig(config);
  const { wikiGoal, ...jsonConfig } = normalizedConfig;

  await writeFile(
    openWikiOnboardingPath,
    `${JSON.stringify(jsonConfig, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  await chmod(openWikiOnboardingPath, 0o600);

  if (wikiGoal?.trim()) {
    await writeFile(openWikiInstructionsPath, `${wikiGoal.trim()}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(openWikiInstructionsPath, 0o600);
  }
}

export function getRepositoryWikiInstructionsPath(repoRoot: string): string {
  return path.join(repoRoot, OPEN_WIKI_DIR, REPOSITORY_INSTRUCTIONS_FILE);
}

export async function readRepositoryWikiInstructions(
  repoRoot: string,
): Promise<string | undefined> {
  try {
    const content = (
      await readFile(getRepositoryWikiInstructionsPath(repoRoot), "utf8")
    ).trim();
    return content.length > 0 ? content : undefined;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }
}

function readRepositoryWikiInstructionsSync(
  repoRoot: string,
): string | undefined {
  const instructionsPath = getRepositoryWikiInstructionsPath(repoRoot);

  if (!existsSync(instructionsPath)) {
    return undefined;
  }

  const content = readFileSync(instructionsPath, "utf8").trim();
  return content.length > 0 ? content : undefined;
}

export async function saveRepositoryWikiInstructions(
  repoRoot: string,
  wikiGoal: string,
): Promise<void> {
  const instructionsPath = getRepositoryWikiInstructionsPath(repoRoot);
  await mkdir(path.dirname(instructionsPath), { recursive: true });
  await writeFile(instructionsPath, `${wikiGoal.trim()}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
}

export function isOnboardingComplete(
  config: OpenWikiOnboardingConfig,
): boolean {
  return Boolean(
    config.completedAt &&
    config.wikiGoal &&
    (isCodeModeConfig(config) || config.ingestionSchedule),
  );
}

export function isOpenWikiOnboardingCompleteSync(): boolean {
  if (!existsSync(openWikiOnboardingPath)) {
    return false;
  }

  try {
    const config = normalizeOnboardingConfig(
      JSON.parse(readFileSync(openWikiOnboardingPath, "utf8")),
    );
    const wikiGoal = readWikiInstructionsSync();

    return isOnboardingComplete({ ...config, wikiGoal });
  } catch {
    return false;
  }
}

export function isRepositoryCodeOnboardingCompleteSync(
  repoRoot: string,
): boolean {
  if (!existsSync(openWikiOnboardingPath)) {
    return false;
  }

  try {
    const config = normalizeOnboardingConfig(
      JSON.parse(readFileSync(openWikiOnboardingPath, "utf8")),
    );
    if (!isCodeModeConfig(config)) {
      return false;
    }

    const wikiGoal = readRepositoryWikiInstructionsSync(repoRoot);

    return isOnboardingComplete({
      ...config,
      wikiGoal,
    });
  } catch {
    return false;
  }
}

async function readWikiInstructions(): Promise<string | undefined> {
  try {
    const content = (await readFile(openWikiInstructionsPath, "utf8")).trim();
    return content.length > 0 ? content : undefined;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }
}

function readWikiInstructionsSync(): string | undefined {
  if (!existsSync(openWikiInstructionsPath)) {
    return undefined;
  }

  const content = readFileSync(openWikiInstructionsPath, "utf8").trim();
  return content.length > 0 ? content : undefined;
}

function normalizeOnboardingConfig(value: unknown): OpenWikiOnboardingConfig {
  if (!isObject(value)) {
    return createEmptyOnboardingConfig();
  }

  const sources = isObject(value.sources) ? value.sources : {};
  const config: OpenWikiOnboardingConfig = {
    sourceInstances: [],
    sources: {},
    version: 1,
  };

  if (typeof value.completedAt === "string") {
    config.completedAt = value.completedAt;
  }

  if (typeof value.wikiGoal === "string") {
    config.wikiGoal = value.wikiGoal;
  }

  if (typeof value.modeId === "string") {
    config.modeId = value.modeId;
  }

  if (typeof value.modeName === "string") {
    config.modeName = value.modeName;
  }

  if (typeof value.templateId === "string") {
    config.templateId = value.templateId;
    config.modeId ??= value.templateId;
  }

  if (typeof value.templateName === "string") {
    config.templateName = value.templateName;
    config.modeName ??= value.templateName;
  }

  if (isObject(value.ingestionSchedule)) {
    config.ingestionSchedule = normalizeSourceScheduleConfig(
      value.ingestionSchedule,
    );
  }

  if (isObject(value.powerManagement)) {
    config.powerManagement = normalizePowerManagementConfig(
      value.powerManagement,
    );
  }

  for (const [sourceId, sourceValue] of Object.entries(sources)) {
    if (!isKnownConnectorId(sourceId) || !isObject(sourceValue)) {
      continue;
    }

    const sourceConfig = normalizeSourceConfig(sourceValue);
    config.sources[sourceId] = sourceConfig;
  }

  if (Array.isArray(value.sourceInstances)) {
    for (const sourceValue of value.sourceInstances) {
      if (
        !isObject(sourceValue) ||
        typeof sourceValue.connectorId !== "string"
      ) {
        continue;
      }

      if (!isKnownConnectorId(sourceValue.connectorId)) {
        continue;
      }

      const id =
        typeof sourceValue.id === "string" && sourceValue.id.trim().length > 0
          ? sourceValue.id
          : createSourceInstanceId(
              sourceValue.connectorId,
              config.sourceInstances.length,
            );
      config.sourceInstances.push({
        ...normalizeSourceConfig(sourceValue),
        connectorId: sourceValue.connectorId,
        id,
        name:
          typeof sourceValue.name === "string" ? sourceValue.name : undefined,
      });
    }
  }

  if (config.sourceInstances.length === 0) {
    for (const [connectorId, sourceConfig] of Object.entries(config.sources)) {
      if (!isKnownConnectorId(connectorId) || !sourceConfig) {
        continue;
      }

      config.sourceInstances.push({
        ...sourceConfig,
        connectorId,
        id: connectorId,
      });
    }
  }

  if (!config.ingestionSchedule) {
    config.ingestionSchedule = config.sourceInstances.find(
      (sourceConfig) => sourceConfig.schedule,
    )?.schedule;
  }

  config.sourceInstances = config.sourceInstances.map((sourceConfig) => {
    const nextSourceConfig = { ...sourceConfig };
    delete nextSourceConfig.schedule;
    return nextSourceConfig;
  });
  config.sources = deriveLegacySources(config.sourceInstances);

  return config;
}

function isCodeModeConfig(config: OpenWikiOnboardingConfig): boolean {
  return (config.modeId ?? config.templateId) === "code";
}

function normalizeSourceConfig(
  value: Record<string, unknown>,
): OnboardingSourceConfig {
  return {
    connectedAt:
      typeof value.connectedAt === "string" ? value.connectedAt : undefined,
    connectorConfig: isObject(value.connectorConfig)
      ? value.connectorConfig
      : undefined,
    ingestionGoal:
      typeof value.ingestionGoal === "string" ? value.ingestionGoal : undefined,
    schedule: isObject(value.schedule)
      ? normalizeSourceScheduleConfig(value.schedule)
      : undefined,
  };
}

function normalizeSourceScheduleConfig(
  value: Record<string, unknown>,
): OnboardingSourceScheduleConfig {
  return {
    description: typeof value.description === "string" ? value.description : "",
    expression: typeof value.expression === "string" ? value.expression : "",
    launchAgentPath:
      typeof value.launchAgentPath === "string"
        ? value.launchAgentPath
        : undefined,
    pausedAt: typeof value.pausedAt === "string" ? value.pausedAt : undefined,
    updatedAt:
      typeof value.updatedAt === "string"
        ? value.updatedAt
        : new Date(0).toISOString(),
    warning: typeof value.warning === "string" ? value.warning : undefined,
  };
}

function deriveLegacySources(
  sourceInstances: OnboardingSourceInstanceConfig[],
): OpenWikiOnboardingConfig["sources"] {
  const sources: OpenWikiOnboardingConfig["sources"] = {};

  for (const sourceInstance of sourceInstances) {
    if (!sources[sourceInstance.connectorId]) {
      sources[sourceInstance.connectorId] = {
        connectedAt: sourceInstance.connectedAt,
        connectorConfig: sourceInstance.connectorConfig,
        ingestionGoal: sourceInstance.ingestionGoal,
      };
    }
  }

  return sources;
}

function createSourceInstanceId(
  connectorId: ConnectorId,
  index: number,
): string {
  return `${connectorId}-${index + 1}`;
}

function normalizePowerManagementConfig(
  value: Record<string, unknown>,
): OpenWikiPowerManagementConfig | undefined {
  if (!isObject(value.pmset)) {
    return undefined;
  }

  return {
    pmset: {
      days: typeof value.pmset.days === "string" ? value.pmset.days : "",
      enabled:
        typeof value.pmset.enabled === "boolean" ? value.pmset.enabled : false,
      sleepTime:
        typeof value.pmset.sleepTime === "string" ? value.pmset.sleepTime : "",
      updatedAt:
        typeof value.pmset.updatedAt === "string"
          ? value.pmset.updatedAt
          : new Date(0).toISOString(),
      wakeTime:
        typeof value.pmset.wakeTime === "string" ? value.pmset.wakeTime : "",
      warning:
        typeof value.pmset.warning === "string"
          ? value.pmset.warning
          : undefined,
    },
  };
}

function isKnownConnectorId(value: string): value is ConnectorId {
  return (
    value === "git-repo" ||
    value === "google" ||
    value === "hackernews" ||
    value === "notion" ||
    value === "slack" ||
    value === "web-search" ||
    value === "x"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
