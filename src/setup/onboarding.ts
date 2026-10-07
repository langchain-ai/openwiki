import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ensureOpenWikiHome,
  openWikiHomeDir,
} from "../config/openwiki-home.js";
import type { ConnectorId } from "../connectors/types.js";
import {
  resolveRepositoryWikiLocation,
  resolveRepositoryWikiLocationSync,
} from "../repository-wiki/config.js";
import {
  DEFAULT_REPOSITORY_WIKI_DIRECTORY,
  resolveRepositoryWikiRoot,
} from "../repository-wiki/paths.js";
import {
  assertRepositoryWikiPathSafe,
  assertRepositoryWikiPathSafeSync,
} from "../repository-wiki/ownership.js";

/**
 * User-level onboarding state file.
 */
export const openWikiOnboardingPath = path.join(
  openWikiHomeDir,
  "onboarding.json",
);
/**
 * User-level personal-wiki instructions file.
 */
export const openWikiInstructionsPath = path.join(
  openWikiHomeDir,
  "INSTRUCTIONS.md",
);
/**
 * User-authored repository wiki brief filename.
 */
export const REPOSITORY_INSTRUCTIONS_FILE = "INSTRUCTIONS.md";

/**
 * Persisted schedule settings for one onboarding source.
 */
export type OnboardingSourceScheduleConfig = {
  description: string;
  expression: string;
  launchAgentPath?: string;
  pausedAt?: string;
  updatedAt: string;
  warning?: string;
};

/**
 * Persisted configuration shared by one source kind.
 */
export type OnboardingSourceConfig = {
  connectedAt?: string;
  connectorConfig?: Record<string, unknown>;
  ingestionGoal?: string;
  schedule?: OnboardingSourceScheduleConfig;
};

/**
 * Named persisted instance of one connector source.
 */
export type OnboardingSourceInstanceConfig = OnboardingSourceConfig & {
  connectorId: ConnectorId;
  id: string;
  name?: string;
};

/**
 * Optional macOS wake and sleep configuration.
 */
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

/**
 * Complete normalized onboarding state.
 */
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

/**
 * Creates the empty supported onboarding state.
 */
export function createEmptyOnboardingConfig(): OpenWikiOnboardingConfig {
  return {
    sourceInstances: [],
    sources: {},
    version: 1,
  };
}

/**
 * Reads and normalizes user-level onboarding state and instructions.
 */
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

/**
 * Persists normalized user-level onboarding state and instructions.
 */
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

/**
 * Resolves the instructions file inside one physical repository wiki.
 */
export function getRepositoryWikiInstructionsPath(
  repoRoot: string,
  wikiDirectory: string = DEFAULT_REPOSITORY_WIKI_DIRECTORY,
): string {
  return path.join(
    resolveRepositoryWikiRoot(repoRoot, wikiDirectory),
    REPOSITORY_INSTRUCTIONS_FILE,
  );
}

/**
 * Reads the optional brief from a repository's configured wiki root.
 */
export async function readRepositoryWikiInstructions(
  repoRoot: string,
): Promise<string | undefined> {
  const wikiLocation = await resolveRepositoryWikiLocation(repoRoot);
  await assertRepositoryWikiPathSafe(repoRoot, wikiLocation.directory);
  try {
    const content = (
      await readFile(
        getRepositoryWikiInstructionsPath(repoRoot, wikiLocation.directory),
        "utf8",
      )
    ).trim();
    return content.length > 0 ? content : undefined;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }
}

/**
 * Reads configured repository instructions during synchronous startup checks.
 */
function readRepositoryWikiInstructionsSync(
  repoRoot: string,
): string | undefined {
  const wikiLocation = resolveRepositoryWikiLocationSync(repoRoot);
  assertRepositoryWikiPathSafeSync(repoRoot, wikiLocation.directory);
  const instructionsPath = getRepositoryWikiInstructionsPath(
    repoRoot,
    wikiLocation.directory,
  );

  if (!existsSync(instructionsPath)) {
    return undefined;
  }

  const content = readFileSync(instructionsPath, "utf8").trim();
  return content.length > 0 ? content : undefined;
}

/**
 * Saves a repository brief inside its configured wiki root.
 */
export async function saveRepositoryWikiInstructions(
  repoRoot: string,
  wikiGoal: string,
): Promise<void> {
  const wikiLocation = await resolveRepositoryWikiLocation(repoRoot);
  await assertRepositoryWikiPathSafe(repoRoot, wikiLocation.directory);
  const instructionsPath = getRepositoryWikiInstructionsPath(
    repoRoot,
    wikiLocation.directory,
  );
  await mkdir(path.dirname(instructionsPath), { recursive: true });
  await writeFile(instructionsPath, `${wikiGoal.trim()}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
}

/**
 * Tests whether normalized onboarding state is runnable.
 */
export function isOnboardingComplete(
  config: OpenWikiOnboardingConfig,
): boolean {
  return Boolean(
    config.completedAt &&
    config.wikiGoal &&
    (isCodeModeConfig(config) || config.ingestionSchedule),
  );
}

/**
 * Checks personal onboarding completion without asynchronous startup work.
 */
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

/**
 * Checks code onboarding completion using configured repository instructions.
 */
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

/**
 * Reads optional user-level personal-wiki instructions.
 */
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

/**
 * Reads user-level personal-wiki instructions synchronously.
 */
function readWikiInstructionsSync(): string | undefined {
  if (!existsSync(openWikiInstructionsPath)) {
    return undefined;
  }

  const content = readFileSync(openWikiInstructionsPath, "utf8").trim();
  return content.length > 0 ? content : undefined;
}

/**
 * Normalizes unknown persisted onboarding data to the supported schema.
 */
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

/**
 * Tests whether onboarding state selects repository code mode.
 */
function isCodeModeConfig(config: OpenWikiOnboardingConfig): boolean {
  return (config.modeId ?? config.templateId) === "code";
}

/**
 * Normalizes one legacy connector source configuration.
 */
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

/**
 * Normalizes one optional persisted source schedule.
 */
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

/**
 * Converts legacy source mappings into normalized source instances.
 */
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

/**
 * Creates a stable unique source-instance identifier.
 */
function createSourceInstanceId(
  connectorId: ConnectorId,
  index: number,
): string {
  return `${connectorId}-${index + 1}`;
}

/**
 * Normalizes optional persisted host power-management settings.
 */
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

/**
 * Tests whether text identifies a supported connector.
 */
function isKnownConnectorId(value: string): value is ConnectorId {
  return (
    value === "custom-mcp" ||
    value === "git-repo" ||
    value === "google" ||
    value === "hackernews" ||
    value === "notion" ||
    value === "slack" ||
    value === "web-search" ||
    value === "x"
  );
}

/**
 * Tests whether an unknown value is a non-array object.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Tests whether a filesystem failure reports an absent file.
 */
function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
