import { existsSync } from "node:fs";
import path from "node:path";
import {
  getMissingProviderEnvKey,
  getProviderApiKeyEnvKey,
  getProviderBaseUrlEnvKey,
  getProviderLocationEnvKey,
  getProviderProjectEnvKey,
  getProviderRegionEnvKey,
  getProviderSecretKeyEnvKey,
  providerRequiresApiKey,
  providerRequiresBaseUrl,
  providerRequiresRegion,
  providerRequiresSecretKey,
  providerUsesAwsSdkCredentials,
  providerUsesExternalCliAuth,
  providerUsesOAuth,
  resolveConfiguredProvider,
  resolveProviderRegion,
  normalizeProvider,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
  type OpenWikiProvider,
} from "../../config/constants.js";
import {
  readCodexTokensFromEnv,
  isChatGptTokenExpired,
} from "../../agent/openai-chatgpt-oauth.js";
import {
  createEmptyOnboardingConfig,
  isOnboardingComplete,
  isOpenWikiOnboardingCompleteSync,
  isRepositoryCodeOnboardingCompleteSync,
  readRepositoryWikiInstructions,
  type OpenWikiOnboardingConfig,
} from "../onboarding.js";
import type { PromptStep, SetupStepState, SourceSetupOption } from "./types.js";
import {
  ONBOARDING_TEMPLATES,
  RUN_MODE_OPTIONS,
  LANGSMITH_REGION_OPTIONS,
  SOURCE_OPTIONS,
} from "./constants.js";
import type { OpenWikiRunMode } from "../../cli/commands.js";
import type { LangSmithRegion } from "../../connectors/sources/langsmith/setup.js";
import type { ConnectorId } from "../../connectors/types.js";

export function needsCredentialSetup(
  modelIdOverride: string | null = null,
  mode: OpenWikiRunMode = "personal",
): boolean {
  const provider = resolveConfiguredProvider();

  const needsCredentials =
    !hasValidConfiguredProvider() ||
    needsAwsCredentialRepair(provider) ||
    needsCredentialStep(provider) ||
    needsSecretKeyStep(provider) ||
    needsBaseUrlStep(provider) ||
    needsRegionStep(provider) ||
    (modelIdOverride === null &&
      process.env[OPENWIKI_MODEL_ID_ENV_KEY] === undefined) ||
    needsLangSmithStep();

  if (needsCredentials) {
    return true;
  }

  return mode === "code"
    ? !isRepositoryCodeOnboardingCompleteSync(getDefaultCodeRepoRootPath())
    : !isOpenWikiOnboardingCompleteSync();
}

export function needsAwsCredentialRepair(provider: OpenWikiProvider): boolean {
  return (
    providerUsesAwsSdkCredentials(provider) &&
    getMissingProviderEnvKey(provider) !== null
  );
}

/**
 * Whether the provider still needs its primary credential collected. For
 * `oauth` providers this is a valid, non-expired stored token; for API-key
 * providers it is a pasted key; for keyless providers (gemini-enterprise) it is
 * the required GCP project id.
 */
export function needsCredentialStep(provider: OpenWikiProvider): boolean {
  if (providerUsesOAuth(provider)) {
    return !hasValidStoredToken();
  }

  return (
    getMissingProviderEnvKey(provider) !== null &&
    credentialStep(provider) !== null
  );
}

/** The step that collects the provider's primary credential. */
export function credentialStep(provider: OpenWikiProvider): PromptStep | null {
  if (providerUsesOAuth(provider)) {
    return "oauth-login";
  }

  if (providerUsesAwsSdkCredentials(provider)) {
    return null;
  }

  if (providerUsesExternalCliAuth(provider)) {
    return "external-cli-auth";
  }

  if (providerRequiresApiKey(provider)) {
    return "api-key";
  }

  return getProviderProjectEnvKey(provider) ? "gcp-project" : null;
}

/**
 * Every managed env key the wizard lets you set for a provider, in checklist
 * order: the provider selection, its credential keys, the model, and the
 * LangSmith tracing key. Used to detect which of them a shell export is
 * currently shadowing (a shell var wins at runtime and would silently override
 * the choice made here). Returns key names only, never values.
 */
export function getWizardManagedEnvKeys(provider: OpenWikiProvider): string[] {
  return [
    OPENWIKI_PROVIDER_ENV_KEY,
    getProviderApiKeyEnvKey(provider),
    getProviderSecretKeyEnvKey(provider),
    getProviderProjectEnvKey(provider),
    getProviderLocationEnvKey(provider),
    getProviderBaseUrlEnvKey(provider),
    getProviderRegionEnvKey(provider),
    OPENWIKI_MODEL_ID_ENV_KEY,
    "LANGSMITH_API_KEY",
  ].filter((key): key is string => key !== undefined);
}

/**
 * The setup steps that apply to a provider and run mode, in the order the wizard
 * walks them. Unlike the skip-based waterfall in {@link getInitialStep}, this
 * includes steps already satisfied by the environment, so navigation can reach
 * and re-edit an auto-skipped step. The provider's primary credential step
 * ({@link credentialStep}) is emitted once; for keyless providers that step is
 * the GCP project, so it is not appended again below.
 */
export function orderedSetupSteps(
  provider: OpenWikiProvider,
  mode: OpenWikiRunMode,
  allowModeSelection: boolean,
): PromptStep[] {
  const steps: PromptStep[] = [];

  if (allowModeSelection) {
    steps.push("run-mode");
  }

  steps.push("provider");

  const primary = credentialStep(provider);
  if (primary) {
    steps.push(primary);
  }

  if (providerRequiresSecretKey(provider)) {
    steps.push("secret-key");
  }
  if (getProviderProjectEnvKey(provider) && primary !== "gcp-project") {
    steps.push("gcp-project");
  }
  if (
    getProviderProjectEnvKey(provider) &&
    getProviderLocationEnvKey(provider)
  ) {
    steps.push("gcp-location");
  }
  if (providerRequiresBaseUrl(provider)) {
    steps.push("base-url");
  }
  if (providerRequiresRegion(provider)) {
    steps.push("region");
  }

  steps.push("model");
  steps.push("langsmith");

  // Personal mode's template is fixed by the run mode, so it skips the
  // Code/Personal chooser and walks straight into the wiki brief. Only code
  // mode needs a spine step after langsmith (repo confirmation).
  if (mode === "code") {
    steps.push("code-repo-confirm");
  }

  return steps;
}

/**
 * The step after `step` in the applicable spine, or null when `step` is the last
 * spine step or outside it. Drives forward navigation: Enter advances to the
 * next applicable step in order rather than skipping ones already satisfied by
 * the environment, so setup reads as a sequential walk.
 */
export function nextSetupStep(
  step: PromptStep | null,
  provider: OpenWikiProvider,
  mode: OpenWikiRunMode,
  allowModeSelection: boolean,
): PromptStep | null {
  if (step === null) {
    return null;
  }
  const spine = orderedSetupSteps(provider, mode, allowModeSelection);
  const index = spine.indexOf(step);
  return index >= 0 && index + 1 < spine.length ? spine[index + 1] : null;
}

export function hasValidStoredToken(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const tokens = readCodexTokensFromEnv(env);

  return tokens !== null && !isChatGptTokenExpired(tokens.expiresAtMs);
}

export function needsGcpProjectStep(provider: OpenWikiProvider): boolean {
  const projectEnvKey = getProviderProjectEnvKey(provider);

  return projectEnvKey ? !process.env[projectEnvKey] : false;
}

export function needsBaseUrlStep(provider: OpenWikiProvider): boolean {
  if (!providerRequiresBaseUrl(provider)) {
    return false;
  }

  return !isBaseUrlConfigured(provider);
}

export function isBaseUrlConfigured(provider: OpenWikiProvider): boolean {
  const baseUrlEnvKey = getProviderBaseUrlEnvKey(provider);

  return baseUrlEnvKey ? Boolean(process.env[baseUrlEnvKey]) : false;
}

export function needsSecretKeyStep(provider: OpenWikiProvider): boolean {
  if (!providerRequiresSecretKey(provider)) {
    return false;
  }

  return !isSecretKeyConfigured(provider);
}

export function isSecretKeyConfigured(provider: OpenWikiProvider): boolean {
  const secretKeyEnvKey = getProviderSecretKeyEnvKey(provider);

  return secretKeyEnvKey ? Boolean(process.env[secretKeyEnvKey]) : false;
}

export function needsRegionStep(provider: OpenWikiProvider): boolean {
  if (!providerRequiresRegion(provider)) {
    return false;
  }

  return !isRegionConfigured(provider);
}

/**
 * Whether the optional LangSmith tracing step still needs to be shown.
 *
 * The step is optional, so "answered" must include skipping it. Skipping does
 * not persist `LANGSMITH_API_KEY` — `saveOpenWikiEnv` strips empty values, so
 * the key is simply absent afterwards. What the step always records instead is
 * `LANGCHAIN_TRACING_V2` (`"false"` on skip, `"true"` when a key is entered),
 * which survives because it is non-empty. So the step is unanswered only when
 * neither a key is present (e.g. from a shell export) nor a tracing decision
 * has been recorded.
 */
export function needsLangSmithStep(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !env.LANGSMITH_API_KEY && env.LANGCHAIN_TRACING_V2 === undefined;
}

export function isRegionConfigured(provider: OpenWikiProvider): boolean {
  return resolveProviderRegion(provider) !== undefined;
}

export function isCredentialConfigured(provider: OpenWikiProvider): boolean {
  return providerUsesOAuth(provider)
    ? hasValidStoredToken()
    : getMissingProviderEnvKey(provider) === null;
}

/**
 * Resolve a checklist row's status. The active step wins, so navigating back to
 * an already-done step shows the current-row cursor rather than a check; a done
 * step reads done; anything else falls to its resting status.
 */
export function resolveStepStatus(
  id: PromptStep,
  activeStep: PromptStep | null,
  done: boolean,
  resting: "optional" | "pending" = "pending",
): SetupStepState {
  if (id === activeStep) {
    return "current";
  }
  if (done) {
    return "done";
  }
  return resting;
}

export function getInitialStep(
  modelIdOverride: string | null,
  provider: OpenWikiProvider,
  onboardingConfig: OpenWikiOnboardingConfig = createEmptyOnboardingConfig(),
  mode: OpenWikiRunMode = "code",
  allowModeSelection = false,
  walkAll = false,
): PromptStep | null {
  if (walkAll) {
    // Explicit --init: always start at the top and walk every applicable step,
    // even ones already configured, instead of skipping to the first unset one.
    return orderedSetupSteps(provider, mode, allowModeSelection)[0] ?? null;
  }

  if (allowModeSelection) {
    return "run-mode";
  }

  if (!hasValidConfiguredProvider()) {
    return "provider";
  }

  if (needsAwsCredentialRepair(provider)) {
    return "region";
  }

  const nextCredentialStep = credentialStep(provider);

  if (needsCredentialStep(provider) && nextCredentialStep) {
    return nextCredentialStep;
  }

  if (needsSecretKeyStep(provider)) {
    return "secret-key";
  }

  if (needsGcpProjectStep(provider)) {
    return "gcp-project";
  }

  if (needsBaseUrlStep(provider)) {
    return "base-url";
  }

  if (needsRegionStep(provider)) {
    return "region";
  }

  if (
    modelIdOverride === null &&
    process.env[OPENWIKI_MODEL_ID_ENV_KEY] === undefined
  ) {
    return "model";
  }

  if (!process.env.LANGSMITH_API_KEY) {
    return "langsmith";
  }

  if (mode === "code" && !isOnboardingComplete(onboardingConfig)) {
    return "code-repo-confirm";
  }

  if (!getConfigModeId(onboardingConfig)) {
    return "template";
  }

  if (!onboardingConfig.wikiGoal) {
    return "wiki-goal";
  }

  if (!isCodeMode(onboardingConfig) && !onboardingConfig.ingestionSchedule) {
    return "global-cron-mode";
  }

  if (!isOnboardingComplete(onboardingConfig)) {
    return "source-menu";
  }

  return null;
}

export function getNextStepAfterProvider(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
  onboardingConfig: OpenWikiOnboardingConfig = createEmptyOnboardingConfig(),
  mode: OpenWikiRunMode = "code",
  forceModelStep = false,
): PromptStep | null {
  if (needsAwsCredentialRepair(provider)) {
    return "region";
  }

  const nextCredentialStep = credentialStep(provider);

  if (needsCredentialStep(provider) && nextCredentialStep) {
    return nextCredentialStep;
  }

  return getNextStepAfterApiKey(
    provider,
    modelIdOverride,
    onboardingConfig,
    mode,
    forceModelStep,
  );
}

export function getNextStepAfterApiKey(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
  onboardingConfig: OpenWikiOnboardingConfig,
  mode: OpenWikiRunMode,
  forceModelStep = false,
): PromptStep | null {
  if (needsSecretKeyStep(provider)) {
    return "secret-key";
  }

  return getNextStepAfterSecretKey(
    provider,
    modelIdOverride,
    onboardingConfig,
    mode,
    forceModelStep,
  );
}

export function getNextStepAfterSecretKey(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
  onboardingConfig: OpenWikiOnboardingConfig,
  mode: OpenWikiRunMode,
  forceModelStep = false,
): PromptStep | null {
  if (needsGcpProjectStep(provider)) {
    return "gcp-project";
  }

  return getNextStepAfterGcpLocation(
    provider,
    modelIdOverride,
    onboardingConfig,
    mode,
    forceModelStep,
  );
}

export function getNextStepAfterGcpLocation(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
  onboardingConfig: OpenWikiOnboardingConfig = createEmptyOnboardingConfig(),
  mode: OpenWikiRunMode = "code",
  forceModelStep = false,
): PromptStep | null {
  if (needsBaseUrlStep(provider)) {
    return "base-url";
  }

  return getNextStepAfterBaseUrl(
    provider,
    modelIdOverride,
    onboardingConfig,
    mode,
    forceModelStep,
  );
}

export function getNextStepAfterBaseUrl(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
  onboardingConfig: OpenWikiOnboardingConfig,
  mode: OpenWikiRunMode,
  forceModelStep = false,
): PromptStep | null {
  if (needsRegionStep(provider)) {
    return "region";
  }

  return getNextStepAfterRegion(
    provider,
    modelIdOverride,
    onboardingConfig,
    mode,
    forceModelStep,
  );
}

export function getNextStepAfterRegion(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
  onboardingConfig: OpenWikiOnboardingConfig,
  mode: OpenWikiRunMode,
  forceModelStep = false,
): PromptStep | null {
  if (
    modelIdOverride === null &&
    (forceModelStep || process.env[OPENWIKI_MODEL_ID_ENV_KEY] === undefined)
  ) {
    return "model";
  }

  if (!process.env.LANGSMITH_API_KEY) {
    return "langsmith";
  }

  if (mode === "code" && !isOnboardingComplete(onboardingConfig)) {
    return "code-repo-confirm";
  }

  if (!getConfigModeId(onboardingConfig)) {
    return "template";
  }

  if (!onboardingConfig.wikiGoal) {
    return "wiki-goal";
  }

  if (!isCodeMode(onboardingConfig) && !onboardingConfig.ingestionSchedule) {
    return "global-cron-mode";
  }

  if (!isOnboardingComplete(onboardingConfig)) {
    return "source-menu";
  }

  return null;
}

export function ensureRunModeConfig(
  config: OpenWikiOnboardingConfig,
  mode: OpenWikiRunMode,
): OpenWikiOnboardingConfig {
  if (getConfigModeId(config) === mode) {
    return mode === "code" && config.wikiGoal !== undefined
      ? { ...config, wikiGoal: undefined }
      : config;
  }

  const runModeTemplate = ONBOARDING_TEMPLATES.find(
    (option) => option.id === mode,
  );
  if (!runModeTemplate) {
    return config;
  }

  return {
    ...config,
    modeId: runModeTemplate.id,
    modeName: runModeTemplate.name,
    templateId: runModeTemplate.id,
    templateName: runModeTemplate.name,
    ...(mode === "code" ? { wikiGoal: undefined } : {}),
  };
}

export async function hydrateRunModeConfig(
  config: OpenWikiOnboardingConfig,
  mode: OpenWikiRunMode,
  repoRoot: string,
): Promise<OpenWikiOnboardingConfig> {
  if (mode !== "code") {
    return config;
  }

  const wikiGoal = await readRepositoryWikiInstructions(repoRoot);

  return { ...config, wikiGoal };
}

export function getRunModeSelectionIndex(mode: OpenWikiRunMode): number {
  const index = RUN_MODE_OPTIONS.findIndex((option) => option.id === mode);
  return index === -1 ? 0 : index;
}

export function getLangsmithRegionSelectionIndex(
  region: LangSmithRegion,
): number {
  const index = LANGSMITH_REGION_OPTIONS.findIndex(
    (option) => option.id === region,
  );
  return index === -1 ? 0 : index;
}

export function getLangsmithRegionLabel(region: LangSmithRegion): string {
  const option = LANGSMITH_REGION_OPTIONS.find((item) => item.id === region);
  return option ? `${option.name} (${option.host})` : region;
}

export function getRunModeName(mode: OpenWikiRunMode): string {
  return RUN_MODE_OPTIONS.find((option) => option.id === mode)?.name ?? mode;
}

export function getSourceOption(sourceId: ConnectorId): SourceSetupOption {
  return (
    SOURCE_OPTIONS.find((source) => source.id === sourceId) ?? SOURCE_OPTIONS[0]
  );
}

export function getConfigModeId(
  config: OpenWikiOnboardingConfig,
): string | undefined {
  return config.modeId ?? config.templateId;
}

export function getConfigModeName(
  config: OpenWikiOnboardingConfig,
): string | undefined {
  return config.modeName ?? config.templateName;
}

export function isCodeMode(config: OpenWikiOnboardingConfig): boolean {
  return getConfigModeId(config) === "code";
}

export function hasValidConfiguredProvider(): boolean {
  return normalizeProvider(process.env[OPENWIKI_PROVIDER_ENV_KEY]) !== null;
}

export function getDefaultCodeRepoRootPath(): string {
  return findNearestGitRepoRoot(process.cwd()) ?? process.cwd();
}

export function findNearestGitRepoRoot(startPath: string): string | null {
  let currentPath = path.resolve(startPath);

  while (true) {
    if (existsSync(path.join(currentPath, ".git"))) {
      return currentPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return null;
    }

    currentPath = parentPath;
  }
}
