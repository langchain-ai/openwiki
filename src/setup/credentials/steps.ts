import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type * as React from "react";
import {
  getMissingProviderEnvKey,
  getProviderApiKeyEnvKey,
  getProviderBaseUrlEnvKey,
  getProviderLocationEnvKey,
  getProviderProjectEnvKey,
  getProviderRegionEnvKey,
  getProviderSecretKeyEnvKey,
  getProviderLabel,
  getDefaultModelId,
  getProviderModelOptions,
  normalizeModelId,
  isValidModelId,
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
  OPENWIKI_REASONING_EFFORT_ENV_KEY,
  SELECTABLE_OPENWIKI_PROVIDERS,
  type OpenWikiProvider,
} from "../../config/constants.js";
import { getReasoningCapability } from "../../config/reasoning.js";
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
import type {
  PromptStep,
  SetupStepState,
  SourceSetupOption,
  ModelSelectionOption,
  SourceSecretInput,
  PromptInputKey,
  ReasoningEffortSelection,
} from "./types.js";
import {
  ONBOARDING_TEMPLATES,
  RUN_MODE_OPTIONS,
  LANGSMITH_REGION_OPTIONS,
  SOURCE_OPTIONS,
  CRON_FIELD_LABELS,
  FINAL_OPTIONS,
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
    OPENWIKI_REASONING_EFFORT_ENV_KEY,
    "LANGSMITH_API_KEY",
  ].filter((key): key is string => key !== undefined);
}

export type ReasoningEffortSelectionOption = {
  label: string;
  value: ReasoningEffortSelection;
};

export function getReasoningEffortSelectionOptions(
  provider: OpenWikiProvider,
  modelId: string,
): ReasoningEffortSelectionOption[] {
  const capability = getReasoningCapability(provider, modelId);

  if (!capability) {
    return [];
  }

  return [
    { label: "Provider default", value: "" },
    ...capability.values.map((value) => ({ label: value, value })),
  ];
}

export function getReasoningEffortSelectionIndex(
  provider: OpenWikiProvider,
  modelId: string,
  value: string | undefined,
): number {
  const options = getReasoningEffortSelectionOptions(provider, modelId);
  const index = options.findIndex((option) => option.value === value);

  return index >= 0 ? index : 0;
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

  if (needsLangSmithStep()) {
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

  if (needsLangSmithStep()) {
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

export function needsEnvValue(secretInput: SourceSecretInput): boolean {
  return !process.env[secretInput.envKey];
}

export function addSourceInstanceConfig(
  config: OpenWikiOnboardingConfig,
  sourceInstance: OpenWikiOnboardingConfig["sourceInstances"][number],
): OpenWikiOnboardingConfig {
  const sourceInstances = [...config.sourceInstances, sourceInstance];
  return {
    ...config,
    sourceInstances,
    sources: deriveLegacySources(sourceInstances),
  };
}

export function deriveLegacySources(
  sourceInstances: OpenWikiOnboardingConfig["sourceInstances"],
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

export function getSourceInstanceCount(
  config: OpenWikiOnboardingConfig,
  sourceId: ConnectorId,
): number {
  return getSourceInstances(config, sourceId).length;
}

export function getSourceInstances(
  config: OpenWikiOnboardingConfig,
  sourceId: ConnectorId,
): OpenWikiOnboardingConfig["sourceInstances"] {
  return config.sourceInstances.filter(
    (sourceInstance) => sourceInstance.connectorId === sourceId,
  );
}

export function getConnectedSourceCount(
  config: OpenWikiOnboardingConfig,
  sourceOptions: readonly SourceSetupOption[],
): number {
  const sourceIds = new Set(sourceOptions.map((source) => source.id));
  return config.sourceInstances.filter((sourceInstance) =>
    sourceIds.has(sourceInstance.connectorId),
  ).length;
}

export function createSourceInstanceId(
  sourceId: ConnectorId,
  config: OpenWikiOnboardingConfig,
): string {
  const sourceCount = getSourceInstanceCount(config, sourceId) + 1;
  return `${sourceId}-${sourceCount}`;
}

export function createSourceInstanceName(
  source: SourceSetupOption,
  description: string,
  config: OpenWikiOnboardingConfig,
): string {
  const sourceCount = getSourceInstanceCount(config, source.id) + 1;
  const trimmedDescription = description.trim();
  const suffix = trimmedDescription.length > 0 ? `: ${trimmedDescription}` : "";
  return `${source.displayName} ${sourceCount}${suffix}`.slice(0, 120);
}

export function isSourceStep(step: PromptStep | null): boolean {
  return Boolean(step?.startsWith("source-"));
}

export function isScheduleStep(step: PromptStep | null): boolean {
  return Boolean(step?.startsWith("global-"));
}

/**
 * Label for the provider's primary credential input. Bedrock authenticates
 * with an IAM access key ID (paired with a secret access key), not a single
 * opaque API key, so its prompt reads differently from every other provider.
 */
export function getApiKeyFieldLabel(provider: OpenWikiProvider): string {
  return provider === "bedrock"
    ? `${getProviderLabel(provider)} access key ID`
    : `${getProviderLabel(provider)} API key`;
}

export function getModelSetupDetail(
  modelIdOverride: string | null,
  provider: OpenWikiProvider,
): string {
  if (modelIdOverride) {
    return `using ${modelIdOverride} for this run`;
  }

  if (process.env[OPENWIKI_MODEL_ID_ENV_KEY]) {
    return process.env[OPENWIKI_MODEL_ID_ENV_KEY] ?? "";
  }

  return `default ${getDefaultModelId(provider)}`;
}

export function getModelSelectionOptions(
  provider: OpenWikiProvider,
): ModelSelectionOption[] {
  return [
    ...getProviderModelOptions(provider).map((model) => ({
      id: model.id,
      kind: "preset" as const,
      label: model.label,
    })),
    { kind: "custom" },
  ];
}

export function shouldStartWithCustomModelInput(
  provider: OpenWikiProvider,
): boolean {
  return getProviderModelOptions(provider).length === 0;
}

export function getSelectedModelId(
  provider: OpenWikiProvider,
  selectedIndex: number,
  input: string,
  isCustomInput: boolean,
): string | null {
  if (!isCustomInput) {
    const selectedOption = getModelSelectionOptions(provider)[selectedIndex];

    if (!selectedOption) {
      return null;
    }

    return selectedOption.kind === "custom" ? "custom" : selectedOption.id;
  }

  const normalizedModelId = normalizeModelId(input);

  return isValidModelId(normalizedModelId) ? normalizedModelId : null;
}

export function getProviderSelectionIndex(provider: OpenWikiProvider): number {
  const selectedIndex = SELECTABLE_OPENWIKI_PROVIDERS.findIndex(
    (providerOption) => providerOption === provider,
  );

  return selectedIndex === -1 ? 0 : selectedIndex;
}

export function getModelSelectionIndex(
  provider: OpenWikiProvider,
  selectedModelId: string,
): number {
  const selectedIndex = getModelSelectionOptions(provider).findIndex(
    (option) => option.kind === "preset" && option.id === selectedModelId,
  );

  return selectedIndex === -1 ? 0 : selectedIndex;
}

export function moveSelectionIndex(
  currentIndex: number,
  offset: number,
  itemCount: number,
): number {
  if (itemCount <= 0) {
    return 0;
  }

  return (currentIndex + offset + itemCount) % itemCount;
}

export function getInputDisplayWidth(
  stdoutColumns: number | undefined,
): number {
  const defaultWidth = 64;

  if (!stdoutColumns || stdoutColumns <= 0) {
    return defaultWidth;
  }

  return Math.max(24, Math.min(96, stdoutColumns - 16));
}

export function getProviderArticle(provider: OpenWikiProvider): "a" | "an" {
  return provider === "baseten" ||
    provider === "fireworks" ||
    provider === "gemini" ||
    provider === "gemini-enterprise" ||
    provider === "nebius"
    ? "a"
    : "an";
}

export function getTemplateGoal(templateId: string | undefined): string {
  return (
    ONBOARDING_TEMPLATES.find((template) => template.id === templateId)
      ?.suggestedGoal ?? ""
  );
}

export function getSourceMenuLabel(
  source: SourceSetupOption,
  sourceInstanceCount: number,
): string {
  return sourceInstanceCount > 0
    ? `Add another ${source.displayName}`
    : `Add ${source.displayName}`;
}

export function getTemplateSourceOptions(
  templateId: string | undefined,
): readonly SourceSetupOption[] {
  const template =
    ONBOARDING_TEMPLATES.find((option) => option.id === templateId) ??
    ONBOARDING_TEMPLATES[0];
  const sourceIds = new Set(template.sourceIds);
  const sourceOptions = SOURCE_OPTIONS.filter((source) =>
    sourceIds.has(source.id),
  );

  return sourceOptions.length > 0 ? sourceOptions : SOURCE_OPTIONS;
}

export function getSourceDescriptionPrompt(source: SourceSetupOption): string {
  if (source.id === "web-search") {
    return "Describe the topics, companies, or pages OpenWiki should search for.";
  }

  if (source.id === "hackernews") {
    return "Describe the topics, keywords, users, or story types OpenWiki should watch on Hacker News.";
  }

  if (source.id === "git-repo") {
    return "Describe what OpenWiki should understand about this repository.";
  }

  return `Describe what OpenWiki should look for in ${source.displayName}.`;
}

export function getFinalOptionLabel(
  option: (typeof FINAL_OPTIONS)[number],
  mode: OpenWikiRunMode,
): string {
  if (mode !== "code") {
    return option;
  }

  return option === "Run ingestion now" ? "Run OpenWiki now" : "Open chat";
}

export function getSourceDescriptionOptionCount(
  source: SourceSetupOption,
): number {
  return source.examples.length + 1;
}

export function handleCronEditorInput({
  currentFieldIndex,
  currentValue,
  fallbackExpression,
  inputValue,
  key,
  replaceCurrentField,
  setCurrentFieldIndex,
  setReplaceCurrentField,
  setValue,
}: {
  currentFieldIndex: number;
  currentValue: string;
  fallbackExpression: string;
  inputValue: string;
  key: PromptInputKey;
  replaceCurrentField: boolean;
  setCurrentFieldIndex: React.Dispatch<React.SetStateAction<number>>;
  setReplaceCurrentField: React.Dispatch<React.SetStateAction<boolean>>;
  setValue: React.Dispatch<React.SetStateAction<string>>;
}): boolean {
  if (key.leftArrow) {
    setCurrentFieldIndex((index) => Math.max(0, index - 1));
    setReplaceCurrentField(true);
    return true;
  }

  if (key.rightArrow || key.tab || inputValue === " " || inputValue === "\t") {
    setCurrentFieldIndex((index) =>
      Math.min(CRON_FIELD_LABELS.length - 1, index + 1),
    );
    setReplaceCurrentField(true);
    return true;
  }

  if (key.backspace || key.delete) {
    const fields = getCronFields(currentValue, fallbackExpression);
    const currentField = fields[currentFieldIndex] ?? "";
    if (currentField.length === 0 && currentFieldIndex > 0) {
      setCurrentFieldIndex(currentFieldIndex - 1);
      setReplaceCurrentField(false);
      return true;
    }

    fields[currentFieldIndex] = currentField.slice(0, -1);
    setValue(fields.join(" "));
    setReplaceCurrentField(false);
    return true;
  }

  if (key.ctrl || key.meta) {
    return false;
  }

  const pastedFields = parseCronFieldPaste(inputValue);
  if (pastedFields.length > 1) {
    const fields = getCronFields(currentValue, fallbackExpression);
    pastedFields.forEach((field, offset) => {
      const fieldIndex = currentFieldIndex + offset;
      if (fieldIndex < CRON_FIELD_LABELS.length) {
        fields[fieldIndex] = field;
      }
    });
    setValue(fields.join(" "));
    setCurrentFieldIndex((index) =>
      Math.min(CRON_FIELD_LABELS.length - 1, index + pastedFields.length - 1),
    );
    setReplaceCurrentField(true);
    return true;
  }

  const sanitizedInput = sanitizeCronInputChunk(inputValue);

  if (!sanitizedInput) {
    return false;
  }

  const fields = getCronFields(currentValue, fallbackExpression);
  fields[currentFieldIndex] = replaceCurrentField
    ? sanitizedInput
    : `${fields[currentFieldIndex] ?? ""}${sanitizedInput}`;
  setValue(fields.join(" "));
  setReplaceCurrentField(false);
  return true;
}

export function getCronFields(
  expression: string,
  fallbackExpression: string,
): string[] {
  const source =
    expression.trim().length > 0 ? expression.trim() : fallbackExpression;
  const fields = source.split(/\s+/u);

  return CRON_FIELD_LABELS.map((_, index) => fields[index] ?? "");
}

export function parseCronFieldPaste(inputValue: string): string[] {
  if (inputValue.trim().length === 0) {
    return [];
  }

  if (/\s/u.test(inputValue)) {
    return inputValue
      .trim()
      .split(/\s+/u)
      .map((field) => sanitizeCronInputChunk(field))
      .filter((field) => field.length > 0);
  }

  const compactValue = sanitizeCronInputChunk(inputValue);

  if (/^[0-9*]{5}$/u.test(compactValue)) {
    return compactValue.split("");
  }

  return [];
}

export function sanitizeInputChunk(value: string): string {
  return value.replace(/[\r\n]/gu, "");
}

export function sanitizeCronInputChunk(value: string): string {
  return value.replace(/[^A-Za-z0-9*,/?#LW.-]/gu, "");
}

export function sanitizeRepoId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 80) || "repo";
}

export function getDefaultLocalGitRepoPath(): string {
  return process.cwd();
}

export async function validateLocalDirectoryPath(
  value: string,
): Promise<string> {
  const normalizedPath = normalizeLocalPath(value);

  if (normalizedPath.length === 0) {
    throw new Error("Enter a local directory.");
  }

  const { stat } = await import("node:fs/promises");
  const pathStat = await stat(normalizedPath);

  if (!pathStat.isDirectory()) {
    throw new Error(`${normalizedPath} is not a directory.`);
  }

  return normalizedPath;
}

export function normalizeLocalPath(value: string): string {
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    return "";
  }

  if (trimmedValue === "~") {
    return homedir();
  }

  if (trimmedValue.startsWith("~/") || trimmedValue.startsWith("~\\")) {
    return path.resolve(homedir(), trimmedValue.slice(2));
  }

  return path.resolve(trimmedValue);
}

export function getStaticSourceConfig(
  sourceId: ConnectorId,
  query: string,
): Record<string, unknown> {
  const queries = query.trim().length > 0 ? [query.trim()] : [];

  if (sourceId === "web-search") {
    return {
      enabled: true,
      includeAnswer: true,
      includeImages: false,
      includeRawContent: false,
      maxResults: 5,
      queries,
      searchDepth: "basic",
      timeRange: "day",
      topic: "general",
    };
  }

  if (sourceId === "hackernews") {
    return {
      enabled: true,
      feeds: ["top", "new"],
      maxItemsPerFeed: 30,
      maxResultsPerQuery: 20,
      queries,
      queryTags: ["story"],
    };
  }

  return {
    enabled: true,
  };
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
