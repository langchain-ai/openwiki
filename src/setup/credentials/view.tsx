import { Box, Text } from "ink";
import {
  DEFAULT_VERTEX_LOCATION,
  getDefaultModelId,
  getMissingProviderEnvKey,
  getProviderApiKeyEnvKey,
  getProviderLabel,
  getProviderLocationEnvKey,
  getProviderProjectEnvKey,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_REASONING_EFFORT_ENV_KEY,
  type OpenWikiProvider,
  providerRequiresBaseUrl,
  providerRequiresRegion,
  providerRequiresSecretKey,
  providerUsesAwsSdkCredentials,
  providerUsesOAuth,
} from "../../config/constants.js";
import type { CodexTokens } from "../../agent/openai-chatgpt-oauth.js";
import type { OpenWikiRunMode } from "../../cli/commands.js";
import type { ExternalCliAuthState } from "../../auth/external-cli-auth.js";
import { getShellEnvValue } from "../../config/env.js";
import type { OpenWikiOnboardingConfig } from "../onboarding.js";
import {
  credentialStep,
  getConnectedSourceCount,
  getModelSetupDetail,
  getReasoningEffortSelectionOptions,
  getRunModeName,
  getWizardManagedEnvKeys,
  hasValidConfiguredProvider,
  isBaseUrlConfigured,
  isCredentialConfigured,
  isRegionConfigured,
  isScheduleStep,
  isSecretKeyConfigured,
  isSourceStep,
  needsAwsCredentialRepair,
  needsBaseUrlStep,
  needsCredentialStep,
  needsLangSmithStep,
  needsRegionStep,
  needsSecretKeyStep,
  resolveStepStatus,
} from "./steps.js";
import { getCredentialSetupDetail } from "./format.js";
import type {
  LangsmithWorkspaceDraft,
  PromptStep,
  SourceSetupOption,
  SourceSetupState,
} from "./types.js";
import {
  OAuthLoginPrompt,
  Prompt,
  SetupHeader,
  SetupPanel,
  SetupStep,
} from "./components.js";

/**
 * Props for {@link InitSetupView}: the full snapshot of wizard state, props,
 * and derived values the setup summary reads. Every field is read-only render
 * input; the view calls no setters or handlers.
 */
export interface InitSetupViewProps {
  /**
   * Whether the run-mode row is a selectable wizard step rather than a fixed,
   * already-decided value.
   */
  allowModeSelection: boolean;

  /** The step currently in focus, or null while the wizard is still seeding. */
  step: PromptStep | null;

  /** The run mode being configured (code vs personal). */
  selectedMode: OpenWikiRunMode;

  /** The provider selected for this run. */
  provider: OpenWikiProvider;

  /** True once the user confirms a provider this session. */
  providerConfirmed: boolean;

  /** API key entered this session, or null when none was typed. */
  apiKey: string | null;

  /** OAuth tokens obtained this session, or null when none were obtained. */
  oauthTokens: CodexTokens | null;

  /** Secret key entered this session, or null when none was typed. */
  secretKey: string | null;

  /** GCP project entered this session, or null when none was typed. */
  gcpProject: string | null;

  /** GCP location entered this session, or null when none was typed. */
  gcpLocation: string | null;

  /** Base URL entered this session, or null when none was typed. */
  baseUrl: string | null;

  /** Region entered this session, or null when none was typed. */
  region: string | null;

  /** Model ID chosen this session, or null when none was chosen. */
  modelId: string | null;

  /** Model ID forced by the caller (`--model`), or null when not overridden. */
  modelIdOverride: string | null;

  /** Reasoning effort selected this session, or null when not collected. */
  reasoningEffort?: string | null;

  /** LangSmith key entered this session, or null when none was typed. */
  langSmithKey: string | null;

  /** The onboarding config as the wizard has edited it so far. */
  onboardingConfig: OpenWikiOnboardingConfig;

  /** True once the OAuth login URL was copied to the clipboard. */
  copied: boolean;

  /** The shared single-line input buffer for the active prompt. */
  input: string;

  /** True while the OAuth browser sign-in is in progress. */
  isLoggingIn: boolean;

  /** The OAuth login URL to display, or null before one is issued. */
  loginUrl: string | null;

  /** Dedicated buffer for the code-repo-path field. */
  codeRepoPathInput: string;

  /** The resolved code-repo root path shown on the confirm step. */
  codeRepoRoot: string;

  /** State of the external CLI credential probe/login. */
  externalCliAuth: ExternalCliAuthState;

  /** Selection cursor for the code-repo confirm menu. */
  codeRepoSelectionIndex: number;

  /** Active field cursor for the segmented cron input. */
  cronFieldSelectionIndex: number;

  /** Selection cursor for the cron mode menu. */
  cronModeSelectionIndex: number;

  /** Selection cursor for the final menu. */
  finalSelectionIndex: number;

  /** True while the user is entering a custom model ID. */
  isCustomModelInput: boolean;

  /** The LangSmith workspace currently being added or edited, or null. */
  langsmithDraft: LangsmithWorkspaceDraft | null;

  /** Selection cursor for the LangSmith region menu. */
  langsmithRegionSelectionIndex: number;

  /** Selection cursor for the LangSmith workspaces menu. */
  langsmithWorkspaceSelectionIndex: number;

  /** LangSmith workspaces as the wizard has edited them. */
  langsmithWorkspaces: LangsmithWorkspaceDraft[];

  /** Selection cursor for the model menu. */
  modelSelectionIndex: number;

  /** Selection cursor for the reasoning effort menu. */
  reasoningEffortSelectionIndex?: number;

  /** Selection cursor for the power-mode menu. */
  powerModeSelectionIndex: number;

  /** Selection cursor for the provider menu. */
  providerSelectionIndex: number;

  /** Selection cursor for the run-mode menu. */
  runModeSelectionIndex: number;

  /** Cursor for the current source secret input field. */
  secretInputIndex: number;

  /** Selection cursor for the source-confirm-continue menu. */
  sourceContinueSelectionIndex: number;

  /** Selection cursor for the source description menu. */
  sourceDescriptionSelectionIndex: number;

  /** Selection cursor for the source menu. */
  sourceSelectionIndex: number;

  /** State of the in-progress source setup (secret values, auth, warnings). */
  sourceState: SourceSetupState;

  /** Selection cursor for the onboarding template menu. */
  templateSelectionIndex: number;

  /** Transient status notice to surface, or null when none. */
  notice: string | null;

  /** Transient error to surface, or null when none. */
  error: string | null;

  /** True while the wizard is writing the setup to disk. */
  isSaving: boolean;

  /** True while waiting for the browser authorization callback. */
  isAuthRunning: boolean;

  /** The active source options for the current mode/template. */
  activeSourceOptions: readonly SourceSetupOption[];

  /** The source option currently selected in the source sub-flow. */
  selectedSource: SourceSetupOption;

  /** The suggested cron expression for the current onboarding config. */
  suggestedCronExpression: string;

  /** The human-readable description of the suggested cron expression. */
  suggestedCronDescription: string;

  /** The computed display width for single-line inputs. */
  inputDisplayWidth: number;

  /**
   * The length of the back-navigation history stack; controls the "esc to go
   * back" hint. Passed as a plain number so the view stays ref-free.
   */
  navHistoryLength: number;
}

/**
 * Presentational, side-effect-free view of the setup wizard. Renders the
 * detected-command summary, the set-up step list, the active prompt panel, and
 * the status/error/saving panels from the props snapshot. It calls no setters
 * and no handlers.
 */
export function InitSetupView({
  allowModeSelection,
  step,
  selectedMode,
  provider,
  providerConfirmed,
  apiKey,
  oauthTokens,
  secretKey,
  gcpProject,
  gcpLocation,
  baseUrl,
  region,
  modelId,
  modelIdOverride,
  reasoningEffort = null,
  langSmithKey,
  onboardingConfig,
  copied,
  input,
  isLoggingIn,
  loginUrl,
  codeRepoPathInput,
  codeRepoRoot,
  externalCliAuth,
  codeRepoSelectionIndex,
  cronFieldSelectionIndex,
  cronModeSelectionIndex,
  finalSelectionIndex,
  isCustomModelInput,
  langsmithDraft,
  langsmithRegionSelectionIndex,
  langsmithWorkspaceSelectionIndex,
  langsmithWorkspaces,
  modelSelectionIndex,
  reasoningEffortSelectionIndex = 0,
  powerModeSelectionIndex,
  providerSelectionIndex,
  runModeSelectionIndex,
  secretInputIndex,
  sourceContinueSelectionIndex,
  sourceDescriptionSelectionIndex,
  sourceSelectionIndex,
  sourceState,
  templateSelectionIndex,
  notice,
  error,
  isSaving,
  isAuthRunning,
  activeSourceOptions,
  selectedSource,
  suggestedCronExpression,
  suggestedCronDescription,
  inputDisplayWidth,
  navHistoryLength,
}: InitSetupViewProps) {
  const needsCredentialPrompt =
    !hasValidConfiguredProvider() ||
    needsAwsCredentialRepair(provider) ||
    needsCredentialStep(provider) ||
    needsSecretKeyStep(provider) ||
    needsBaseUrlStep(provider) ||
    needsRegionStep(provider) ||
    (modelIdOverride === null &&
      process.env[OPENWIKI_MODEL_ID_ENV_KEY] === undefined) ||
    needsLangSmithStep();
  const apiKeyEnvKey = getProviderApiKeyEnvKey(provider);
  const primaryCredentialStep = credentialStep(provider);
  const projectEnvKey = getProviderProjectEnvKey(provider);
  const locationEnvKey = getProviderLocationEnvKey(provider);
  const selectedModelId =
    modelId ??
    modelIdOverride ??
    process.env[OPENWIKI_MODEL_ID_ENV_KEY] ??
    getDefaultModelId(provider);
  const reasoningEffortOptions = getReasoningEffortSelectionOptions(
    provider,
    selectedModelId,
  );

  // A shell export wins over saved config at runtime. List any wizard-managed
  // keys present in the shell so their precedence is not a surprise and the
  // "from shell" rows below are explained. Presence only, not a value compare;
  // key names only, never values.
  const shadowedShellKeys = getWizardManagedEnvKeys(provider).filter(
    (key) => getShellEnvValue(key) !== undefined,
  );
  const isSingleShadow = shadowedShellKeys.length === 1;
  const shadowedShellWarning =
    shadowedShellKeys.length === 0
      ? null
      : `${
          isSingleShadow ? "This key was" : "These keys were"
        } detected in your shell and ${
          isSingleShadow ? "overrides" : "override"
        } saved config: ${shadowedShellKeys.join(", ")}. Runs use the shell ` +
        `value${isSingleShadow ? "" : "s"}; unset ${
          isSingleShadow ? "it" : "them"
        } to use your saved config.`;

  return (
    <Box flexDirection="column">
      <SetupHeader />

      {shadowedShellWarning ? (
        <Box marginBottom={1} marginLeft={2}>
          <Text color="yellow">⚠ {shadowedShellWarning}</Text>
        </Box>
      ) : null}

      <Box flexDirection="column" marginBottom={1} marginLeft={2}>
        <Text color="gray">Detected from your command</Text>
        <Box flexDirection="column" marginLeft={2}>
          <SetupStep
            label="Run mode"
            state={
              allowModeSelection
                ? step === "run-mode"
                  ? "current"
                  : "done"
                : "done"
            }
            detail={getRunModeName(selectedMode)}
          />
          {selectedMode === "code" ? (
            <SetupStep label="Wiki scope" state="done" detail="openwiki/" />
          ) : null}
        </Box>
      </Box>

      <Box flexDirection="column" marginLeft={2}>
        <Text color="gray">Set up</Text>
        <Box flexDirection="column" marginLeft={2}>
          <SetupStep
            label="Provider"
            state={resolveStepStatus(
              "provider",
              step,
              hasValidConfiguredProvider() || providerConfirmed,
            )}
            detail={getProviderLabel(provider)}
          />
          {providerUsesAwsSdkCredentials(provider) ? (
            <SetupStep
              label="AWS credentials"
              state={
                getMissingProviderEnvKey(provider) === null ? "done" : "pending"
              }
              detail={getCredentialSetupDetail(provider)}
            />
          ) : providerUsesOAuth(provider) || primaryCredentialStep ? (
            <SetupStep
              label={
                providerUsesOAuth(provider) ? "ChatGPT login" : "Provider key"
              }
              state={resolveStepStatus(
                primaryCredentialStep ?? "provider",
                step,
                apiKey !== null ||
                  isCredentialConfigured(provider) ||
                  oauthTokens !== null,
              )}
              detail={
                providerUsesOAuth(provider)
                  ? getCredentialSetupDetail(provider, oauthTokens)
                  : apiKeyEnvKey && getShellEnvValue(apiKeyEnvKey) !== undefined
                    ? "from shell"
                    : apiKey !== null || isCredentialConfigured(provider)
                      ? "configured"
                      : "not set"
              }
            />
          ) : null}
          {providerRequiresSecretKey(provider) ? (
            <SetupStep
              label="Secret key"
              state={resolveStepStatus(
                "secret-key",
                step,
                secretKey !== null || isSecretKeyConfigured(provider),
              )}
              detail={
                secretKey !== null || isSecretKeyConfigured(provider)
                  ? "configured"
                  : "not set"
              }
            />
          ) : null}
          {projectEnvKey ? (
            <SetupStep
              label="GCP project"
              state={resolveStepStatus(
                "gcp-project",
                step,
                gcpProject !== null || process.env[projectEnvKey] !== undefined,
              )}
              detail={
                gcpProject ??
                (process.env[projectEnvKey] ? "configured" : "not set")
              }
            />
          ) : null}
          {projectEnvKey && locationEnvKey ? (
            <SetupStep
              label="GCP location"
              state={resolveStepStatus(
                "gcp-location",
                step,
                gcpLocation !== null ||
                  process.env[locationEnvKey] !== undefined,
                "optional",
              )}
              detail={
                gcpLocation ??
                (process.env[locationEnvKey]
                  ? "configured"
                  : `default ${DEFAULT_VERTEX_LOCATION}`)
              }
            />
          ) : null}
          {providerRequiresBaseUrl(provider) ? (
            <SetupStep
              label="Base URL"
              state={resolveStepStatus(
                "base-url",
                step,
                baseUrl !== null || isBaseUrlConfigured(provider),
              )}
              detail={
                baseUrl ??
                (isBaseUrlConfigured(provider) ? "configured" : "not set")
              }
            />
          ) : null}
          {providerRequiresRegion(provider) ? (
            <SetupStep
              label="Region"
              state={resolveStepStatus(
                "region",
                step,
                region !== null || isRegionConfigured(provider),
              )}
              detail={
                region ??
                (isRegionConfigured(provider) ? "configured" : "not set")
              }
            />
          ) : null}
          <SetupStep
            label="Model"
            state={resolveStepStatus(
              "model",
              step,
              modelId !== null ||
                modelIdOverride !== null ||
                process.env[OPENWIKI_MODEL_ID_ENV_KEY] !== undefined,
            )}
            detail={modelId ?? getModelSetupDetail(modelIdOverride, provider)}
          />
          {reasoningEffortOptions.length > 0 ? (
            <SetupStep
              label="Reasoning effort"
              state={resolveStepStatus(
                "reasoning-effort",
                step,
                reasoningEffort !== null ||
                  process.env[OPENWIKI_REASONING_EFFORT_ENV_KEY] !== undefined,
                "optional",
              )}
              detail={
                reasoningEffort ??
                process.env[OPENWIKI_REASONING_EFFORT_ENV_KEY] ??
                "provider default"
              }
            />
          ) : null}
          <SetupStep
            label="LangSmith"
            state={resolveStepStatus(
              "langsmith",
              step,
              // Answered when a key exists (this session or in env) or a tracing
              // decision was recorded; !needsLangSmithStep() covers both, so a
              // prior decline reads done instead of resetting to optional.
              langSmithKey !== null || !needsLangSmithStep(),
              "optional",
            )}
            detail={
              langSmithKey !== null
                ? langSmithKey.length > 0
                  ? "configured"
                  : "skipped"
                : process.env.LANGSMITH_API_KEY
                  ? "configured"
                  : // A recorded tracing decision with no key means the step was
                    // seen and declined on an earlier run, so it reads "skipped".
                    process.env.LANGCHAIN_TRACING_V2 !== undefined
                    ? "skipped"
                    : "not set"
            }
          />
          {selectedMode === "personal" ? (
            <SetupStep
              label="Wiki scope"
              state={resolveStepStatus(
                "wiki-goal",
                step,
                Boolean(onboardingConfig.wikiGoal),
              )}
              detail={onboardingConfig.wikiGoal ? "configured" : "not set"}
            />
          ) : null}
          {selectedMode === "personal" ? (
            <SetupStep
              label="Schedule"
              state={
                isScheduleStep(step)
                  ? "current"
                  : onboardingConfig.ingestionSchedule
                    ? "done"
                    : "pending"
              }
              detail={
                onboardingConfig.ingestionSchedule
                  ? onboardingConfig.ingestionSchedule.description
                  : "not set"
              }
            />
          ) : null}
          {selectedMode === "personal" ? (
            <SetupStep
              label="Sources"
              state={
                isSourceStep(step)
                  ? "current"
                  : getConnectedSourceCount(
                        onboardingConfig,
                        activeSourceOptions,
                      ) > 0
                    ? "done"
                    : "pending"
              }
              detail={`${getConnectedSourceCount(
                onboardingConfig,
                activeSourceOptions,
              )} configured`}
            />
          ) : null}
        </Box>
      </Box>

      {step === "oauth-login" ? (
        <OAuthLoginPrompt
          copied={copied}
          input={input}
          isLoggingIn={isLoggingIn}
          loginUrl={loginUrl}
          provider={provider}
        />
      ) : (
        <SetupPanel title="Prompt">
          {step ? (
            <Prompt
              codeRepoPathInput={codeRepoPathInput}
              codeRepoRoot={codeRepoRoot}
              externalCliAuth={externalCliAuth}
              codeRepoSelectionIndex={codeRepoSelectionIndex}
              cronFieldSelectionIndex={cronFieldSelectionIndex}
              cronModeSelectionIndex={cronModeSelectionIndex}
              finalSelectionIndex={finalSelectionIndex}
              input={input}
              inputDisplayWidth={inputDisplayWidth}
              isCustomModelInput={isCustomModelInput}
              langsmithDraft={langsmithDraft}
              langsmithRegionSelectionIndex={langsmithRegionSelectionIndex}
              langsmithWorkspaceSelectionIndex={
                langsmithWorkspaceSelectionIndex
              }
              langsmithWorkspaces={langsmithWorkspaces}
              modelSelectionIndex={modelSelectionIndex}
              reasoningEffortOptions={reasoningEffortOptions}
              reasoningEffortSelectionIndex={reasoningEffortSelectionIndex}
              onboardingConfig={onboardingConfig}
              powerModeSelectionIndex={powerModeSelectionIndex}
              provider={provider}
              providerSelectionIndex={providerSelectionIndex}
              runModeSelectionIndex={runModeSelectionIndex}
              secretInputIndex={secretInputIndex}
              selectedMode={selectedMode}
              selectedSource={selectedSource}
              sourceOptions={activeSourceOptions}
              sourceContinueSelectionIndex={sourceContinueSelectionIndex}
              sourceDescriptionSelectionIndex={sourceDescriptionSelectionIndex}
              sourceSelectionIndex={sourceSelectionIndex}
              sourceState={sourceState}
              step={step}
              suggestedCronDescription={suggestedCronDescription}
              suggestedCronExpression={suggestedCronExpression}
              templateSelectionIndex={templateSelectionIndex}
            />
          ) : (
            <Text>Inspecting OpenWiki setup...</Text>
          )}
        </SetupPanel>
      )}

      {navHistoryLength > 0 ? (
        <Box marginLeft={2}>
          <Text color="gray">esc to go back</Text>
        </Box>
      ) : null}

      {needsCredentialPrompt ? (
        <Box marginLeft={2}>
          <Text color="gray">
            Secrets are masked and saved only after setup.
          </Text>
        </Box>
      ) : null}
      {notice ? (
        <SetupPanel title="Status">
          <Text color="cyan">{notice}</Text>
        </SetupPanel>
      ) : null}
      {error ? (
        <SetupPanel title="Error">
          <Text color="red">{error}</Text>
        </SetupPanel>
      ) : null}
      {sourceState.savedScheduleWarning ? (
        <SetupPanel title="Schedule note">
          <Text color="yellow">{sourceState.savedScheduleWarning}</Text>
        </SetupPanel>
      ) : null}
      {isSaving ? (
        <SetupPanel title="Saving">
          <Text>Writing OpenWiki setup...</Text>
        </SetupPanel>
      ) : null}
      {isAuthRunning ? (
        <SetupPanel title="Authorization">
          <Text>Waiting for the browser authorization callback...</Text>
        </SetupPanel>
      ) : null}
    </Box>
  );
}
