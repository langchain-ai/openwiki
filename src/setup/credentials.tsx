import React, { useEffect, useMemo, useRef, useState } from "react";
import { homedir } from "node:os";
import path from "node:path";
import { Box, Text, useInput, useStdin, useStdout } from "ink";
import { configureAuthProvider } from "../auth/configure.js";
import { runOAuthAuth } from "../auth/oauth.js";
import {
  DEFAULT_PROVIDER,
  DEFAULT_VERTEX_LOCATION,
  getDefaultModelId,
  getMissingProviderEnvKey,
  getProviderApiKeyEnvKey,
  getProviderBaseUrlEnvKey,
  getProviderBaseUrlWarnings,
  getProviderLabel,
  getProviderLocationEnvKey,
  getProviderModelOptions,
  getProviderProjectEnvKey,
  getProviderRegionEnvKey,
  getProviderRegionEnvKeys,
  getProviderSecretKeyEnvKey,
  isValidModelId,
  normalizeModelId,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
  type OpenWikiProvider,
  providerRequiresBaseUrl,
  providerRequiresRegion,
  providerRequiresSecretKey,
  providerUsesAwsSdkCredentials,
  providerUsesExternalCliAuth,
  providerUsesOAuth,
  resolveConfiguredProvider,
  resolveProviderRegion,
  SELECTABLE_OPENWIKI_PROVIDERS,
} from "../config/constants.js";
import {
  type ChatGptLoginHandle,
  type CodexTokens,
  codexTokensToEnv,
  loginWithChatGPT,
} from "../agent/openai-chatgpt-oauth.js";
import type { AuthProviderId } from "../auth/types.js";
import type { OpenWikiRunMode } from "../cli/commands.js";
import {
  loadLangSmithSetup,
  nextLangSmithApiKeyEnv,
  saveLangSmithSetup,
} from "../connectors/sources/langsmith/setup.js";
import type { ConnectorId } from "../connectors/types.js";
import {
  detectExternalCliCredential,
  getExternalCliAuthAdapter,
  isExternalCliAvailable,
  runExternalCliLogin,
  type ExternalCliAuthState,
} from "../auth/external-cli-auth.js";
import { getConnectorConfigPath } from "../config/openwiki-home.js";
import {
  getSavedEnvValue,
  getShellEnvValue,
  saveOpenWikiEnv,
} from "../config/env.js";
import {
  createEmptyOnboardingConfig,
  isOnboardingComplete,
  readOpenWikiOnboardingConfig,
  saveRepositoryWikiInstructions,
  saveOpenWikiOnboardingConfig,
  type OpenWikiOnboardingConfig,
} from "./onboarding.js";
import {
  getSuggestedCronExpression,
  installOpenWikiPowerSchedule,
  installConnectorSchedule,
  validateCronExpression,
} from "../scheduling/schedules.js";

import {
  credentialStep,
  ensureRunModeConfig,
  getConfigModeId,
  getConfigModeName,
  getDefaultCodeRepoRootPath,
  getInitialStep,
  getLangsmithRegionLabel,
  getLangsmithRegionSelectionIndex,
  getNextStepAfterApiKey,
  getNextStepAfterBaseUrl,
  getNextStepAfterGcpLocation,
  getNextStepAfterProvider,
  getNextStepAfterRegion,
  getNextStepAfterSecretKey,
  getRunModeName,
  getRunModeSelectionIndex,
  getSourceOption,
  getWizardManagedEnvKeys,
  hasValidConfiguredProvider,
  hydrateRunModeConfig,
  isBaseUrlConfigured,
  isCodeMode,
  isCredentialConfigured,
  isRegionConfigured,
  isSecretKeyConfigured,
  needsAwsCredentialRepair,
  needsBaseUrlStep,
  needsCredentialStep,
  needsLangSmithStep,
  needsRegionStep,
  needsSecretKeyStep,
  nextSetupStep,
  resolveStepStatus,
} from "./credentials/steps.js";
import {
  copyToClipboard,
  formatSecretInputDisplay,
  formatTerminalHyperlink,
  getAwsCredentialRepairMessage,
  getCredentialSetupDetail,
  getOAuthAuthorizationStatusText,
  getSingleLineInputDisplayValue,
  mask,
  openLoginUrl,
} from "./credentials/format.js";
import {
  CODE_REPO_OPTIONS,
  CRON_FIELD_LABELS,
  CRON_MODE_OPTIONS,
  FINAL_OPTIONS,
  LANGSMITH_REGION_OPTIONS,
  ONBOARDING_TEMPLATES,
  POWER_MODE_OPTIONS,
  RUN_MODE_OPTIONS,
  SOURCE_CONTINUE_OPTIONS,
  SOURCE_OPTIONS,
  STEP_COLOR,
  STEP_GLYPH,
} from "./credentials/constants.js";
import type {
  InitSetupProps,
  LangsmithWorkspaceDraft,
  ModelSelectionOption,
  PromptInputKey,
  PromptStep,
  SetupStepState,
  SourceSecretInput,
  SourceSetupOption,
  SourceSetupState,
} from "./credentials/types.js";

export type { InitSetupResult } from "./credentials/types.js";
export {
  ensureRunModeConfig,
  findNearestGitRepoRoot,
  getInitialStep,
  getNextStepAfterProvider,
  hydrateRunModeConfig,
  needsCredentialSetup,
  needsLangSmithStep,
  nextSetupStep,
  orderedSetupSteps,
  resolveStepStatus,
} from "./credentials/steps.js";
export { getOAuthAuthorizationStatusText } from "./credentials/format.js";

export function InitSetup({
  allowModeSelection = false,
  mode,
  modelIdOverride = null,
  onComplete,
  onError,
  walkAllSteps = false,
}: InitSetupProps) {
  const { stdout } = useStdout();
  const initialProvider = resolveConfiguredProvider();
  const [step, setStepRaw] = useState<PromptStep | null>(null);
  const navHistory = useRef<PromptStep[]>([]);
  // Guards the mount effect so the initial step is seeded once per mount, not
  // re-seeded when the effect re-fires on parent re-renders.
  const didInitializeRef = useRef(false);
  // Seed the LangSmith selection from the committed config only once, so
  // navigating back and re-confirming the repo does not clobber in-progress edits
  // (the file is not written until setup completes).
  const langsmithPreloadedRef = useRef(false);
  /**
   * Advance to a step, recording the current step on the back-navigation
   * history unless this is a back move. A ref-backed stack so Esc can retrace
   * the actual path taken (including the branchy source sub-flow), which a
   * linear spine cannot model.
   */
  function setStep(next: PromptStep | null, opts?: { back?: boolean }): void {
    if (!opts?.back && step !== null && next !== null && next !== step) {
      navHistory.current.push(step);
    }
    setStepRaw(next);
  }
  const [selectedMode, setSelectedMode] = useState<OpenWikiRunMode>(mode);
  const [provider, setProvider] = useState<OpenWikiProvider>(initialProvider);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [secretKey, setSecretKey] = useState<string | null>(null);
  const [region, setRegion] = useState<string | null>(null);
  const [gcpProject, setGcpProject] = useState<string | null>(null);
  const [gcpLocation, setGcpLocation] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [langSmithKey, setLangSmithKey] = useState<string | null>(null);
  // LangSmith workspaces as the wizard edits them (region + key + projects),
  // seeded from the committed config; committed on completion.
  const [langsmithWorkspaces, setLangsmithWorkspaces] = useState<
    LangsmithWorkspaceDraft[]
  >([]);
  // The workspace currently being added or edited, folded into langsmithWorkspaces
  // when its projects step is confirmed.
  const [langsmithDraft, setLangsmithDraft] =
    useState<LangsmithWorkspaceDraft | null>(null);
  // Index of the workspace being edited; === langsmithWorkspaces.length for a new
  // one.
  const [langsmithEditingIndex, setLangsmithEditingIndex] = useState(0);
  const [
    langsmithWorkspaceSelectionIndex,
    setLangsmithWorkspaceSelectionIndex,
  ] = useState(0);
  const [langsmithRegionSelectionIndex, setLangsmithRegionSelectionIndex] =
    useState(0);
  // True once the LangSmith workspaces were opened this run; guards the WYSIWYG
  // write so an untouched setup never rewrites openwiki/.langsmith.json.
  const [langsmithSourcesTouched, setLangsmithSourcesTouched] = useState(false);
  // True once the user confirms a provider this session. Provider always holds a
  // default value, so a null-check cannot detect the in-session choice.
  const [providerConfirmed, setProviderConfirmed] = useState(false);
  const [input, setInput] = useState("");
  const [onboardingConfig, setOnboardingConfig] =
    useState<OpenWikiOnboardingConfig>(() => createEmptyOnboardingConfig());
  const [sourceState, setSourceState] = useState<SourceSetupState>({
    secretValues: {},
  });
  const [selectedSourceId, setSelectedSourceId] =
    useState<ConnectorId>("git-repo");
  const [secretInputIndex, setSecretInputIndex] = useState(0);
  const [providerSelectionIndex, setProviderSelectionIndex] = useState(() =>
    getProviderSelectionIndex(initialProvider),
  );
  const [modelSelectionIndex, setModelSelectionIndex] = useState(() =>
    getModelSelectionIndex(
      initialProvider,
      modelIdOverride ??
        process.env[OPENWIKI_MODEL_ID_ENV_KEY] ??
        getDefaultModelId(initialProvider),
    ),
  );
  const [runModeSelectionIndex, setRunModeSelectionIndex] = useState(() =>
    getRunModeSelectionIndex(mode),
  );
  const [sourceSelectionIndex, setSourceSelectionIndex] = useState(0);
  const [sourceDescriptionSelectionIndex, setSourceDescriptionSelectionIndex] =
    useState(0);
  const [templateSelectionIndex, setTemplateSelectionIndex] = useState(0);
  const [cronModeSelectionIndex, setCronModeSelectionIndex] = useState(0);
  const [powerModeSelectionIndex, setPowerModeSelectionIndex] = useState(0);
  const [cronFieldSelectionIndex, setCronFieldSelectionIndex] = useState(0);
  const [cronReplaceCurrentField, setCronReplaceCurrentField] = useState(true);
  const [sourceContinueSelectionIndex, setSourceContinueSelectionIndex] =
    useState(0);
  const [finalSelectionIndex, setFinalSelectionIndex] = useState(0);
  const [codeRepoSelectionIndex, setCodeRepoSelectionIndex] = useState(0);
  const [codeRepoRoot, setCodeRepoRoot] = useState(() =>
    getDefaultCodeRepoRootPath(),
  );
  // Dedicated buffer for the code-repo-path field, kept separate from the shared
  // `input` (which seedInputForStep prefills with credentials on other steps) so
  // a secret never shares the buffer that feeds the thread-id path hash.
  const [codeRepoPathInput, setCodeRepoPathInput] = useState("");
  const [codeRepoConfirmed, setCodeRepoConfirmed] = useState(false);
  const [isCustomModelInput, setIsCustomModelInput] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [externalCliAuth, setExternalCliAuth] = useState<ExternalCliAuthState>({
    kind: "idle",
  });
  const externalCliProbeProvider = useRef<OpenWikiProvider | null>(null);
  const { setRawMode } = useStdin();
  const [isAuthRunning, setIsAuthRunning] = useState(false);
  const [oauthTokens, setOauthTokens] = useState<CodexTokens | null>(null);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginAttempt, setLoginAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  const [forceModelStep, setForceModelStep] = useState(false);
  const loginHandleRef = useRef<ChatGptLoginHandle | null>(null);

  const activeSourceOptions = useMemo(
    () => getTemplateSourceOptions(getConfigModeId(onboardingConfig)),
    [onboardingConfig.modeId, onboardingConfig.templateId],
  );
  const selectedSource = getSourceOption(selectedSourceId);
  const suggestedCronExpression = useMemo(
    () => getSuggestedCronExpression(onboardingConfig),
    [onboardingConfig],
  );
  const suggestedCronDescription = useMemo(() => {
    const validation = validateCronExpression(suggestedCronExpression);
    return validation.valid ? validation.description : suggestedCronExpression;
  }, [suggestedCronExpression]);
  const inputDisplayWidth = getInputDisplayWidth(stdout.columns);

  useEffect(() => {
    let cancelled = false;

    readOpenWikiOnboardingConfig()
      .then(async (config) => {
        // Seed the initial step exactly once per mount. onComplete/onError are
        // inline parent closures in the deps, so this effect re-fires on parent
        // re-renders; without this guard a re-fire would reset step back to the
        // first step (getInitialStep with walkAll always returns it).
        if (cancelled || didInitializeRef.current) {
          return;
        }
        didInitializeRef.current = true;

        const defaultRepoRoot = getDefaultCodeRepoRootPath();
        const configForMode = allowModeSelection
          ? config
          : await hydrateRunModeConfig(
              ensureRunModeConfig(config, mode),
              mode,
              defaultRepoRoot,
            );
        if (configForMode !== config) {
          await saveOpenWikiOnboardingConfig({
            ...configForMode,
            wikiGoal: mode === "code" ? undefined : configForMode.wikiGoal,
          });
        }
        setOnboardingConfig(configForMode);
        const initialStep = getInitialStep(
          modelIdOverride,
          initialProvider,
          configForMode,
          mode,
          allowModeSelection,
          walkAllSteps,
        );

        if (initialStep === null) {
          onComplete({
            mode,
            modelId:
              modelIdOverride ?? process.env[OPENWIKI_MODEL_ID_ENV_KEY] ?? null,
            onboardingCompleted: true,
            provider: initialProvider,
            runIngestionNow: false,
            savedApiKey: false,
            savedBaseUrl: false,
            savedGcpLocation: false,
            savedGcpProject: false,
            savedLangSmithKey: false,
            savedModelId: false,
            savedProvider: false,
            savedRegion: false,
            savedSecretKey: false,
            shouldContinueToRun: true,
          });
          return;
        }

        setProvider(initialProvider);
        setProviderSelectionIndex(getProviderSelectionIndex(initialProvider));
        setModelSelectionIndex(
          getModelSelectionIndex(
            initialProvider,
            modelIdOverride ??
              process.env[OPENWIKI_MODEL_ID_ENV_KEY] ??
              getDefaultModelId(initialProvider),
          ),
        );
        setIsCustomModelInput(
          initialStep === "model" &&
            shouldStartWithCustomModelInput(initialProvider),
        );
        if (initialStep === "wiki-goal") {
          setInput(getTemplateGoal(getConfigModeId(config)));
        }
        if (initialStep === "code-repo-confirm") {
          setCodeRepoRoot(defaultRepoRoot);
          setCodeRepoSelectionIndex(0);
        }
        setStep(initialStep);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          onError(getErrorMessage(loadError));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    allowModeSelection,
    initialProvider,
    modelIdOverride,
    onComplete,
    onError,
    mode,
  ]);

  // Drive the browser OAuth login whenever the wizard enters the oauth-login
  // step or the user retries after a failure.
  useEffect(() => {
    if (step !== "oauth-login") {
      return;
    }

    let cancelled = false;

    setIsLoggingIn(true);
    setLoginUrl(null);
    setCopied(false);
    setInput("");
    setError(null);
    loginHandleRef.current = null;

    void (async () => {
      try {
        const tokens = await loginWithChatGPT(
          (url) => {
            if (cancelled) {
              return;
            }

            setLoginUrl(url);
            openLoginUrl(url);
          },
          (handle) => {
            if (!cancelled) {
              loginHandleRef.current = handle;
            }
          },
        );

        if (cancelled) {
          return;
        }

        setOauthTokens(tokens);
        setIsLoggingIn(false);

        const nextStep =
          nextSetupStep(
            "oauth-login",
            provider,
            selectedMode,
            allowModeSelection,
          ) ??
          getNextStepAfterApiKey(
            provider,
            modelIdOverride,
            onboardingConfig,
            selectedMode,
            forceModelStep,
          );

        if (nextStep) {
          setIsCustomModelInput(
            nextStep === "model" && shouldStartWithCustomModelInput(provider),
          );
          seedInputForStep(nextStep);
          setStep(nextStep);
          return;
        }

        await completeSetup({
          nextApiKey: apiKey,
          nextBaseUrl: baseUrl,
          nextSecretKey: secretKey,
          nextRegion: region,
          nextGcpLocation: gcpLocation,
          nextGcpProject: gcpProject,
          nextLangSmithKey: langSmithKey,
          nextModelId: modelId,
          nextOAuthTokens: tokens,
          nextProvider: provider,
          runMode: selectedMode,
        });
      } catch (loginError) {
        if (cancelled) {
          return;
        }

        setIsLoggingIn(false);
        setError(getErrorMessage(loginError));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [step, loginAttempt]);

  useEffect(() => {
    if (
      step !== "external-cli-auth" ||
      !providerUsesExternalCliAuth(provider) ||
      externalCliProbeProvider.current === provider
    ) {
      return;
    }

    externalCliProbeProvider.current = provider;

    let cancelled = false;
    setExternalCliAuth({ kind: "checking" });

    void (async () => {
      const credential = await detectExternalCliCredential(provider);

      if (cancelled) {
        return;
      }

      if (credential) {
        setExternalCliAuth({ kind: "detected" });
        return;
      }

      const cliAvailable = await isExternalCliAvailable(provider);

      if (cancelled) {
        return;
      }

      setExternalCliAuth({ kind: "not-detected", cliAvailable });
    })();

    return () => {
      cancelled = true;
    };
  }, [step, provider]);

  async function launchExternalCliLogin() {
    setExternalCliAuth({ kind: "logging-in" });
    setRawMode?.(false);

    try {
      const success = await runExternalCliLogin(provider);

      if (!success) {
        setExternalCliAuth({ kind: "login-failed" });
        return;
      }

      const credential = await detectExternalCliCredential(provider);

      setExternalCliAuth(
        credential
          ? { kind: "detected" }
          : { kind: "not-detected", cliAvailable: true },
      );
    } finally {
      setRawMode?.(true);
    }
  }

  /**
   * Pre-fill the input or selection for a step reached via navigation, so a done
   * step opens ready to edit. Secret steps are pre-filled with the stored key,
   * which renders as dots (formatSecretInputDisplay), never raw.
   */
  function seedInputForStep(target: PromptStep): void {
    switch (target) {
      case "provider":
        setProviderSelectionIndex(getProviderSelectionIndex(provider));
        break;
      case "run-mode":
        setRunModeSelectionIndex(getRunModeSelectionIndex(selectedMode));
        break;
      case "source-langsmith-region":
        setLangsmithRegionSelectionIndex(
          getLangsmithRegionSelectionIndex(langsmithDraft?.region ?? "us"),
        );
        break;
      case "source-langsmith-key":
        // Prefill an edited workspace's key from ~/.openwiki/.env so it can be
        // kept or replaced; a new workspace starts empty.
        setInput(
          langsmithDraft?.apiKey ||
            (langsmithDraft
              ? (getSavedEnvValue(langsmithDraft.apiKeyEnv) ?? "")
              : ""),
        );
        break;
      case "source-langsmith-projects":
        setInput((langsmithDraft?.projects ?? []).join(", "));
        break;
      case "model": {
        // Point the cursor at the saved model (or the --modelId override), not
        // the provider default, so it matches the checklist on a re-walk.
        const seededModelId =
          modelId ??
          modelIdOverride ??
          getSavedEnvValue(OPENWIKI_MODEL_ID_ENV_KEY) ??
          getDefaultModelId(provider);
        setModelSelectionIndex(getModelSelectionIndex(provider, seededModelId));
        // Preset-less providers (e.g. Bedrock) take the model as free text, so
        // restore the saved id into the field; selection-based providers drive
        // off the index and keep the input empty.
        setInput(
          shouldStartWithCustomModelInput(provider)
            ? (modelId ??
                modelIdOverride ??
                getSavedEnvValue(OPENWIKI_MODEL_ID_ENV_KEY) ??
                "")
            : "",
        );
        break;
      }
      case "api-key": {
        const envKey = getProviderApiKeyEnvKey(provider);
        setInput(apiKey ?? (envKey ? (getSavedEnvValue(envKey) ?? "") : ""));
        break;
      }
      case "external-cli-auth": {
        const envKey = getProviderApiKeyEnvKey(provider);
        setInput(apiKey ?? (envKey ? (getSavedEnvValue(envKey) ?? "") : ""));
        break;
      }
      case "secret-key": {
        const envKey = getProviderSecretKeyEnvKey(provider);
        setInput(secretKey ?? (envKey ? (getSavedEnvValue(envKey) ?? "") : ""));
        break;
      }
      case "base-url": {
        const envKey = getProviderBaseUrlEnvKey(provider);
        setInput(baseUrl ?? (envKey ? (getSavedEnvValue(envKey) ?? "") : ""));
        break;
      }
      case "region": {
        const envKey = getProviderRegionEnvKey(provider);
        setInput(region ?? (envKey ? (getSavedEnvValue(envKey) ?? "") : ""));
        break;
      }
      case "gcp-project": {
        const envKey = getProviderProjectEnvKey(provider);
        setInput(
          gcpProject ?? (envKey ? (getSavedEnvValue(envKey) ?? "") : ""),
        );
        break;
      }
      case "gcp-location": {
        const envKey = getProviderLocationEnvKey(provider);
        setInput(
          gcpLocation ?? (envKey ? (getSavedEnvValue(envKey) ?? "") : ""),
        );
        break;
      }
      case "langsmith":
        // Prefill from state or the saved config (masked as dots), matching the
        // api-key/secret-key steps, so a walk-through Enter keeps the existing
        // key instead of submitting empty and clearing it.
        setInput(langSmithKey ?? getSavedEnvValue("LANGSMITH_API_KEY") ?? "");
        break;
      case "template":
        setTemplateSelectionIndex(
          Math.max(
            0,
            ONBOARDING_TEMPLATES.findIndex(
              (template) => template.id === getConfigModeId(onboardingConfig),
            ),
          ),
        );
        setInput("");
        break;
      case "wiki-goal":
        setInput(onboardingConfig.wikiGoal ?? "");
        break;
      case "global-cron-mode":
        setCronModeSelectionIndex(0);
        setInput("");
        break;
      case "global-cron-custom":
        setInput(
          onboardingConfig.ingestionSchedule?.expression ??
            suggestedCronExpression,
        );
        setCronFieldSelectionIndex(0);
        setCronReplaceCurrentField(true);
        break;
      case "global-power-mode":
        setPowerModeSelectionIndex(0);
        setInput("");
        break;
      case "source-menu":
        // Park the cursor on the "Continue" row so Enter keeps sources as-is.
        setSourceSelectionIndex(activeSourceOptions.length);
        setInput("");
        break;
      case "source-description":
        setSourceDescriptionSelectionIndex(0);
        setInput("");
        break;
      case "source-confirm-continue":
        setSourceContinueSelectionIndex(0);
        setInput("");
        break;
      case "final":
        setFinalSelectionIndex(0);
        setInput("");
        break;
      case "code-repo-confirm":
        setCodeRepoSelectionIndex(0);
        setInput("");
        break;
      case "code-repo-path":
        setCodeRepoPathInput(codeRepoRoot);
        break;
      default:
        setInput("");
    }
  }

  /**
   * Commit the current step's typed value into state so stepping back with Esc
   * preserves it rather than discarding an unsubmitted edit. Only text-input
   * steps carry a value here; selection steps commit on their own submit.
   */
  function captureInputForStep(from: PromptStep): void {
    const trimmed = input.trim();
    switch (from) {
      case "api-key":
      case "external-cli-auth":
        if (trimmed) setApiKey(trimmed);
        break;
      case "secret-key":
        if (trimmed) setSecretKey(trimmed);
        break;
      case "base-url":
        if (trimmed) setBaseUrl(trimmed);
        break;
      case "region":
        if (trimmed) setRegion(trimmed);
        break;
      case "gcp-project":
        if (trimmed) setGcpProject(trimmed);
        break;
      case "gcp-location":
        if (trimmed) setGcpLocation(trimmed);
        break;
      case "langsmith":
        setLangSmithKey(trimmed);
        break;
      case "source-langsmith-key":
        // Keep an unsubmitted key edit on the draft so Esc does not lose it.
        setLangsmithDraft((draft) =>
          draft ? { ...draft, apiKey: trimmed } : draft,
        );
        break;
      case "source-langsmith-projects":
        // Keep an unsubmitted list edit on the draft so Esc does not lose it.
        setLangsmithDraft((draft) =>
          draft
            ? {
                ...draft,
                projects: [
                  ...new Set(
                    input
                      .split(",")
                      .map((name) => name.trim())
                      .filter((name) => name.length > 0),
                  ),
                ],
              }
            : draft,
        );
        break;
      case "wiki-goal":
        // Keep an unsubmitted goal edit in-session (not yet persisted) so
        // stepping back and forward does not lose it.
        if (trimmed) {
          setOnboardingConfig((config) => ({ ...config, wikiGoal: trimmed }));
        }
        break;
      default:
        break;
    }
  }

  useInput((inputValue, key) => {
    if (
      isSaving ||
      isAuthRunning ||
      (isLoggingIn && step !== "oauth-login") ||
      step === null
    ) {
      return;
    }

    // Esc retraces the actual path taken via the navigation history stack, so
    // it works through the branchy source sub-flow too. It commits the current
    // field first (so an unsubmitted edit is kept) and is a no-op at the start.
    if (key.escape) {
      const target = navHistory.current[navHistory.current.length - 1];
      if (target !== undefined) {
        captureInputForStep(step);
        navHistory.current.pop();
        setStep(target, { back: true });
        seedInputForStep(target);
        setError(null);
        setNotice(null);
      }
      return;
    }

    if (step === "oauth-login") {
      if (
        input.length === 0 &&
        (inputValue === "c" || inputValue === "C") &&
        !key.ctrl &&
        !key.meta
      ) {
        if (loginUrl) {
          copyToClipboard(loginUrl);
          setCopied(true);
        }

        return;
      }

      if (key.return) {
        const pasted = input.trim();

        if (pasted.length > 0) {
          submitManualLogin(pasted);
        } else if (!isLoggingIn) {
          setLoginAttempt((attempt) => attempt + 1);
        }

        return;
      }

      if (key.backspace || key.delete) {
        setInput((value) => value.slice(0, -1));
        return;
      }

      const sanitizedInput = sanitizeInputChunk(inputValue);

      if (sanitizedInput && !key.ctrl && !key.meta) {
        setError(null);
        setInput((value) => value + sanitizedInput);
      }

      return;
    }

    if (
      step === "external-cli-auth" &&
      key.tab &&
      externalCliAuth.kind !== "checking" &&
      externalCliAuth.kind !== "logging-in"
    ) {
      void launchExternalCliLogin();
      return;
    }

    if (step === "provider") {
      handleMenuInput(key, () =>
        setProviderSelectionIndex((index) =>
          moveSelectionIndex(
            index,
            key.upArrow ? -1 : 1,
            SELECTABLE_OPENWIKI_PROVIDERS.length,
          ),
        ),
      );
      return;
    }

    if (step === "model" && !isCustomModelInput) {
      handleMenuInput(key, () =>
        setModelSelectionIndex((index) =>
          moveSelectionIndex(
            index,
            key.upArrow ? -1 : 1,
            getModelSelectionOptions(provider).length,
          ),
        ),
      );
      return;
    }

    if (step === "run-mode") {
      handleMenuInput(key, () =>
        setRunModeSelectionIndex((index) =>
          moveSelectionIndex(
            index,
            key.upArrow ? -1 : 1,
            RUN_MODE_OPTIONS.length,
          ),
        ),
      );
      return;
    }

    if (step === "source-langsmith-workspaces") {
      handleMenuInput(key, () =>
        setLangsmithWorkspaceSelectionIndex((index) =>
          moveSelectionIndex(
            index,
            key.upArrow ? -1 : 1,
            // workspaces + "Add a workspace" + "Done".
            langsmithWorkspaces.length + 2,
          ),
        ),
      );
      return;
    }

    if (step === "source-langsmith-region") {
      handleMenuInput(key, () =>
        setLangsmithRegionSelectionIndex((index) =>
          moveSelectionIndex(
            index,
            key.upArrow ? -1 : 1,
            LANGSMITH_REGION_OPTIONS.length,
          ),
        ),
      );
      return;
    }

    if (step === "code-repo-confirm") {
      handleMenuInput(key, () =>
        setCodeRepoSelectionIndex((index) =>
          moveSelectionIndex(
            index,
            key.upArrow ? -1 : 1,
            CODE_REPO_OPTIONS.length,
          ),
        ),
      );
      return;
    }

    if (step === "source-menu") {
      handleMenuInput(key, () =>
        setSourceSelectionIndex((index) =>
          moveSelectionIndex(
            index,
            key.upArrow ? -1 : 1,
            activeSourceOptions.length + 1,
          ),
        ),
      );
      return;
    }

    if (step === "template") {
      handleMenuInput(key, () =>
        setTemplateSelectionIndex((index) =>
          moveSelectionIndex(
            index,
            key.upArrow ? -1 : 1,
            ONBOARDING_TEMPLATES.length,
          ),
        ),
      );
      return;
    }

    if (step === "global-cron-mode") {
      handleMenuInput(key, () =>
        setCronModeSelectionIndex((index) =>
          moveSelectionIndex(
            index,
            key.upArrow ? -1 : 1,
            CRON_MODE_OPTIONS.length,
          ),
        ),
      );
      return;
    }

    if (step === "global-power-mode") {
      handleMenuInput(key, () =>
        setPowerModeSelectionIndex((index) =>
          moveSelectionIndex(
            index,
            key.upArrow ? -1 : 1,
            POWER_MODE_OPTIONS.length,
          ),
        ),
      );
      return;
    }

    if (step === "source-description") {
      handleMenuInput(key, () =>
        setSourceDescriptionSelectionIndex((index) =>
          moveSelectionIndex(
            index,
            key.upArrow ? -1 : 1,
            getSourceDescriptionOptionCount(selectedSource),
          ),
        ),
      );
      return;
    }

    if (step === "source-confirm-continue") {
      handleMenuInput(key, () =>
        setSourceContinueSelectionIndex((index) =>
          moveSelectionIndex(
            index,
            key.upArrow ? -1 : 1,
            SOURCE_CONTINUE_OPTIONS.length,
          ),
        ),
      );
      return;
    }

    if (step === "final") {
      handleMenuInput(key, () =>
        setFinalSelectionIndex((index) =>
          moveSelectionIndex(index, key.upArrow ? -1 : 1, FINAL_OPTIONS.length),
        ),
      );
      return;
    }

    if (step === "source-auth") {
      if (key.return) {
        void submit();
      }
      return;
    }

    if (step === "global-cron-custom") {
      if (key.return) {
        void submit();
        return;
      }

      const didHandleCronInput = handleCronEditorInput({
        currentFieldIndex: cronFieldSelectionIndex,
        currentValue: input,
        fallbackExpression: suggestedCronExpression,
        inputValue,
        key,
        replaceCurrentField: cronReplaceCurrentField,
        setCurrentFieldIndex: setCronFieldSelectionIndex,
        setReplaceCurrentField: setCronReplaceCurrentField,
        setValue: setInput,
      });

      if (didHandleCronInput) {
        setError(null);
      }

      return;
    }

    if (step === "code-repo-path") {
      if (key.return) {
        void submit();
        return;
      }

      if (key.backspace || key.delete) {
        setCodeRepoPathInput((value) => value.slice(0, -1));
        return;
      }

      const sanitizedInput = sanitizeInputChunk(inputValue);

      if (sanitizedInput && !key.ctrl && !key.meta) {
        setError(null);
        setCodeRepoPathInput((value) => value + sanitizedInput);
      }

      return;
    }

    if (key.return) {
      void submit();
      return;
    }

    if (key.backspace || key.delete) {
      setInput((value) => value.slice(0, -1));
      return;
    }

    const sanitizedInput = sanitizeInputChunk(inputValue);

    if (sanitizedInput && !key.ctrl && !key.meta) {
      setInput((value) => value + sanitizedInput);
    }
  });

  function handleMenuInput(key: PromptInputKey, move: () => void) {
    if (key.upArrow || key.downArrow) {
      setError(null);
      move();
      return;
    }

    if (key.return) {
      void submit();
    }
  }

  async function submit() {
    setError(null);
    setNotice(null);

    if (step === "run-mode") {
      const selectedOption =
        RUN_MODE_OPTIONS[runModeSelectionIndex] ?? RUN_MODE_OPTIONS[0];

      setSelectedMode(selectedOption.id);
      setRunModeSelectionIndex(getRunModeSelectionIndex(selectedOption.id));
      setInput("");
      const nextOnboardingConfig = ensureRunModeConfig(
        onboardingConfig,
        selectedOption.id,
      );

      if (nextOnboardingConfig !== onboardingConfig) {
        await saveConfig(nextOnboardingConfig);
      }

      const nextStep = getInitialStep(
        modelIdOverride,
        provider,
        nextOnboardingConfig,
        selectedOption.id,
        false,
      );

      if (nextStep) {
        seedInputForStep(nextStep);
        setStep(nextStep);
        return;
      }

      await completeSetup({
        nextApiKey: apiKey,
        nextBaseUrl: baseUrl,
        nextSecretKey: secretKey,
        nextRegion: region,
        nextGcpLocation: gcpLocation,
        nextGcpProject: gcpProject,
        nextLangSmithKey: langSmithKey,
        nextModelId: modelId,
        nextOAuthTokens: oauthTokens,
        nextProvider: provider,
        runMode: selectedOption.id,
      });
      return;
    }

    if (step === "code-repo-confirm") {
      const selectedOption =
        CODE_REPO_OPTIONS[codeRepoSelectionIndex] ?? CODE_REPO_OPTIONS[0];

      if (selectedOption === "Edit path") {
        setCodeRepoPathInput(codeRepoRoot);
        setStep("code-repo-path");
        return;
      }

      setCodeRepoConfirmed(true);
      continueAfterCodeRepoConfirmed(codeRepoRoot);
      return;
    }

    if (step === "code-repo-path") {
      try {
        const repoRoot = await validateLocalDirectoryPath(codeRepoPathInput);
        setCodeRepoRoot(repoRoot);
        setCodeRepoConfirmed(true);
        setCodeRepoPathInput("");
        continueAfterCodeRepoConfirmed(repoRoot);
      } catch (pathError) {
        setError(getErrorMessage(pathError));
      }
      return;
    }

    if (step === "provider") {
      const selectedProvider =
        SELECTABLE_OPENWIKI_PROVIDERS[providerSelectionIndex] ??
        DEFAULT_PROVIDER;
      // Credentials are provider-specific, so switching providers must not carry
      // the previous provider's key/secret/etc. across (otherwise seedInputForStep
      // prefills it and empty-submit-keeps would save it under the new provider).
      const switchedProvider = selectedProvider !== provider;

      setProvider(selectedProvider);
      setProviderConfirmed(true);

      if (switchedProvider) {
        setApiKey(null);
        setSecretKey(null);
        setBaseUrl(null);
        setRegion(null);
        setGcpProject(null);
        setGcpLocation(null);
        setOauthTokens(null);
        setModelId(null);
      }

      setProviderSelectionIndex(getProviderSelectionIndex(selectedProvider));
      setModelSelectionIndex(
        getModelSelectionIndex(
          selectedProvider,
          getDefaultModelId(selectedProvider),
        ),
      );
      setInput("");
      const providerChanged =
        process.env[OPENWIKI_PROVIDER_ENV_KEY] !== selectedProvider;
      setForceModelStep(providerChanged);
      const nextStep =
        nextSetupStep(
          "provider",
          selectedProvider,
          selectedMode,
          allowModeSelection,
        ) ??
        getNextStepAfterProvider(
          selectedProvider,
          modelIdOverride,
          onboardingConfig,
          selectedMode,
          providerChanged,
        );

      if (nextStep) {
        setIsCustomModelInput(
          nextStep === "model" &&
            shouldStartWithCustomModelInput(selectedProvider),
        );
        // On a switch the closure still holds the old provider/apiKey, so
        // seedInputForStep would re-seed stale values; leave the field empty and
        // let a later visit seed from the new provider's own env.
        if (switchedProvider) {
          setInput("");
        } else {
          seedInputForStep(nextStep);
        }
        setStep(nextStep);
        return;
      }

      await completeSetup({
        nextApiKey: apiKey,
        nextBaseUrl: baseUrl,
        nextSecretKey: secretKey,
        nextRegion: region,
        nextGcpLocation: gcpLocation,
        nextGcpProject: gcpProject,
        nextLangSmithKey: langSmithKey,
        nextModelId: modelId,
        nextOAuthTokens: oauthTokens,
        nextProvider: selectedProvider,
        runMode: selectedMode,
      });
      return;
    }

    if (step === "api-key" || step === "external-cli-auth") {
      const trimmedInput = input.trim();
      const usesExternalCli = step === "external-cli-auth";
      // Empty submit keeps an existing key (session or env). For an external
      // CLI session it deliberately saves nothing: the CLI remains the token
      // owner and the runtime resolves it again for this process only.
      const nextApiKey =
        trimmedInput.length > 0
          ? trimmedInput
          : usesExternalCli && externalCliAuth.kind === "detected"
            ? null
            : apiKey;

      if (
        nextApiKey === null &&
        !(usesExternalCli && externalCliAuth.kind === "detected") &&
        !isCredentialConfigured(provider)
      ) {
        setError(
          `${getProviderApiKeyEnvKey(provider) ?? "API key"} is required.`,
        );
        return;
      }

      if (trimmedInput.length > 0) {
        setApiKey(trimmedInput);
      }
      setInput("");
      const nextStep =
        nextSetupStep(step, provider, selectedMode, allowModeSelection) ??
        getNextStepAfterApiKey(
          provider,
          modelIdOverride,
          onboardingConfig,
          selectedMode,
          forceModelStep,
        );

      if (nextStep) {
        setIsCustomModelInput(
          nextStep === "model" && shouldStartWithCustomModelInput(provider),
        );
        seedInputForStep(nextStep);
        setStep(nextStep);
        return;
      }

      await completeSetup({
        nextApiKey,
        nextBaseUrl: baseUrl,
        nextSecretKey: secretKey,
        nextRegion: region,
        nextGcpLocation: gcpLocation,
        nextGcpProject: gcpProject,
        nextLangSmithKey: langSmithKey,
        nextModelId: modelId,
        nextOAuthTokens: oauthTokens,
        nextProvider: provider,
        runMode: selectedMode,
      });
      return;
    }

    if (step === "secret-key") {
      const trimmedInput = input.trim();
      // Empty submit keeps an existing secret key (see the api-key step).
      const nextSecretKey = trimmedInput.length > 0 ? trimmedInput : secretKey;

      if (nextSecretKey === null && !isSecretKeyConfigured(provider)) {
        setError(
          `${getProviderSecretKeyEnvKey(provider) ?? "Secret key"} is required.`,
        );
        return;
      }

      if (trimmedInput.length > 0) {
        setSecretKey(trimmedInput);
      }
      setInput("");
      const nextStep =
        nextSetupStep(
          "secret-key",
          provider,
          selectedMode,
          allowModeSelection,
        ) ??
        getNextStepAfterSecretKey(
          provider,
          modelIdOverride,
          onboardingConfig,
          selectedMode,
          forceModelStep,
        );

      if (nextStep) {
        setIsCustomModelInput(
          nextStep === "model" && shouldStartWithCustomModelInput(provider),
        );
        seedInputForStep(nextStep);
        setStep(nextStep);
        return;
      }

      await completeSetup({
        nextApiKey: apiKey,
        nextBaseUrl: baseUrl,
        nextSecretKey,
        nextRegion: region,
        nextGcpLocation: gcpLocation,
        nextGcpProject: gcpProject,
        nextLangSmithKey: langSmithKey,
        nextModelId: modelId,
        nextOAuthTokens: oauthTokens,
        nextProvider: provider,
        runMode: selectedMode,
      });
      return;
    }

    if (step === "region") {
      const trimmedInput = input.trim();
      const configuredRegion = resolveProviderRegion(provider);
      const credentialRepairMessage = getAwsCredentialRepairMessage(provider);

      if (credentialRepairMessage) {
        setError(credentialRepairMessage);
        return;
      }

      if (trimmedInput.length === 0 && !configuredRegion) {
        const regionEnvKeys = getProviderRegionEnvKeys(provider);
        setError(
          `Set one of ${regionEnvKeys.join(", ") || "the supported region variables"}.`,
        );
        return;
      }

      const nextRegion = trimmedInput.length > 0 ? trimmedInput : region;

      if (trimmedInput.length > 0) {
        setRegion(trimmedInput);
      }
      setInput("");
      const nextStep =
        nextSetupStep("region", provider, selectedMode, allowModeSelection) ??
        getNextStepAfterRegion(
          provider,
          modelIdOverride,
          onboardingConfig,
          selectedMode,
          forceModelStep,
        );

      if (nextStep) {
        setIsCustomModelInput(
          nextStep === "model" && shouldStartWithCustomModelInput(provider),
        );
        seedInputForStep(nextStep);
        setStep(nextStep);
        return;
      }

      await completeSetup({
        nextApiKey: apiKey,
        nextBaseUrl: baseUrl,
        nextSecretKey: secretKey,
        nextRegion,
        nextGcpLocation: gcpLocation,
        nextGcpProject: gcpProject,
        nextLangSmithKey: langSmithKey,
        nextModelId: modelId,
        nextOAuthTokens: oauthTokens,
        nextProvider: provider,
        runMode: selectedMode,
      });
      return;
    }

    if (step === "gcp-project") {
      const trimmedInput = input.trim();

      if (trimmedInput.length === 0) {
        setError(
          `${getProviderProjectEnvKey(provider) ?? "GCP project"} is required.`,
        );
        return;
      }

      if (/\s/u.test(trimmedInput)) {
        setError("Enter a valid Google Cloud project ID (no spaces).");
        return;
      }

      setGcpProject(trimmedInput);
      setInput("");
      // gcp-location always follows gcp-project (gemini-enterprise); seed it so a
      // previously entered location is restored instead of arriving blank.
      seedInputForStep("gcp-location");
      setStep("gcp-location");
      return;
    }

    if (step === "gcp-location") {
      const trimmedInput = input.trim();

      if (/\s/u.test(trimmedInput)) {
        setError(
          `Enter a valid location (no spaces), or leave blank for ${DEFAULT_VERTEX_LOCATION}.`,
        );
        return;
      }

      const nextGcpLocation = trimmedInput.length > 0 ? trimmedInput : null;

      setGcpLocation(nextGcpLocation);
      setInput("");
      const nextStep =
        nextSetupStep(
          "gcp-location",
          provider,
          selectedMode,
          allowModeSelection,
        ) ??
        getNextStepAfterGcpLocation(
          provider,
          modelIdOverride,
          onboardingConfig,
          selectedMode,
          forceModelStep,
        );

      if (nextStep) {
        setIsCustomModelInput(
          nextStep === "model" && shouldStartWithCustomModelInput(provider),
        );
        seedInputForStep(nextStep);
        setStep(nextStep);
        return;
      }

      await completeSetup({
        nextApiKey: apiKey,
        nextBaseUrl: baseUrl,
        nextSecretKey: secretKey,
        nextRegion: region,
        nextGcpLocation,
        nextGcpProject: gcpProject,
        nextLangSmithKey: langSmithKey,
        nextModelId: modelId,
        nextOAuthTokens: oauthTokens,
        nextProvider: provider,
        runMode: selectedMode,
      });
      return;
    }

    if (step === "base-url") {
      const trimmedInput = input.trim();

      if (trimmedInput.length === 0) {
        setError(
          `${getProviderBaseUrlEnvKey(provider) ?? "Base URL"} is required.`,
        );
        return;
      }

      const baseUrlWarnings = getProviderBaseUrlWarnings(
        provider,
        trimmedInput,
      );
      if (baseUrlWarnings.length > 0) {
        setError(`Enter a valid base URL: ${baseUrlWarnings.join(", ")}.`);
        return;
      }

      setBaseUrl(trimmedInput);
      setInput("");
      const nextStep =
        nextSetupStep("base-url", provider, selectedMode, allowModeSelection) ??
        getNextStepAfterBaseUrl(
          provider,
          modelIdOverride,
          onboardingConfig,
          selectedMode,
          forceModelStep,
        );

      if (nextStep) {
        setIsCustomModelInput(
          nextStep === "model" && shouldStartWithCustomModelInput(provider),
        );
        seedInputForStep(nextStep);
        setStep(nextStep);
        return;
      }

      await completeSetup({
        nextApiKey: apiKey,
        nextBaseUrl: trimmedInput,
        nextSecretKey: secretKey,
        nextRegion: region,
        nextGcpLocation: gcpLocation,
        nextGcpProject: gcpProject,
        nextLangSmithKey: langSmithKey,
        nextModelId: modelId,
        nextOAuthTokens: oauthTokens,
        nextProvider: provider,
        runMode: selectedMode,
      });
      return;
    }

    if (step === "model") {
      const selectedModelId = getSelectedModelId(
        provider,
        modelSelectionIndex,
        input,
        isCustomModelInput,
      );

      if (!selectedModelId) {
        setError("Paste a valid model ID.");
        return;
      }

      if (selectedModelId === "custom") {
        setIsCustomModelInput(true);
        setInput("");
        return;
      }

      setModelId(selectedModelId);
      setInput("");
      setIsCustomModelInput(false);

      // Sequential: always visit LangSmith next (the next spine step). Seed it
      // from state so a key entered earlier and stepped past is not dropped.
      seedInputForStep("langsmith");
      setStep("langsmith");
      return;
    }

    if (step === "langsmith") {
      const nextLangSmithKey = input.trim();

      setLangSmithKey(nextLangSmithKey);
      setInput("");

      await continueAfterCredentials({
        nextApiKey: apiKey,
        nextBaseUrl: baseUrl,
        nextSecretKey: secretKey,
        nextRegion: region,
        nextGcpLocation: gcpLocation,
        nextGcpProject: gcpProject,
        nextLangSmithKey,
        nextModelId: modelId,
        nextOAuthTokens: oauthTokens,
        nextProvider: provider,
        runMode: selectedMode,
      });
      return;
    }

    if (step === "wiki-goal") {
      const wikiGoal = input.trim();

      if (wikiGoal.length === 0) {
        setError("Describe what this wiki should understand.");
        return;
      }

      const nextConfig = {
        ...onboardingConfig,
        wikiGoal,
      };
      await saveConfigForCurrentMode(nextConfig);
      setInput("");

      if (isCodeMode(nextConfig)) {
        setStep("final");
        return;
      }

      setCronModeSelectionIndex(0);
      setCronFieldSelectionIndex(0);
      setCronReplaceCurrentField(true);
      setStep("global-cron-mode");
      return;
    }

    if (step === "template") {
      const selectedTemplate =
        ONBOARDING_TEMPLATES[templateSelectionIndex] ?? ONBOARDING_TEMPLATES[0];
      const nextConfig = {
        ...onboardingConfig,
        modeId: selectedTemplate.id,
        modeName: selectedTemplate.name,
        templateId: selectedTemplate.id,
        templateName: selectedTemplate.name,
      };
      await saveConfig(nextConfig);
      // Keep the existing goal when the template is unchanged (so re-walking is
      // idempotent); use the template's suggested goal when it actually changed.
      const keepExistingGoal =
        selectedTemplate.id === getConfigModeId(onboardingConfig) &&
        onboardingConfig.wikiGoal !== undefined &&
        onboardingConfig.wikiGoal.length > 0;
      setInput(
        keepExistingGoal
          ? (onboardingConfig.wikiGoal ?? "")
          : selectedTemplate.suggestedGoal,
      );
      setStep("wiki-goal");
      return;
    }

    if (step === "source-menu") {
      if (sourceSelectionIndex >= activeSourceOptions.length) {
        // Code mode auto-configures the repo, so its sources are all optional;
        // "Continue" always advances to the wiki brief rather than nagging.
        if (isCodeMode(onboardingConfig)) {
          advanceAfterCodeSources();
          return;
        }

        if (
          getConnectedSourceCount(onboardingConfig, activeSourceOptions) > 0
        ) {
          setStep("final");
          return;
        }

        setSourceContinueSelectionIndex(0);
        setStep("source-confirm-continue");
        return;
      }

      const source =
        activeSourceOptions[sourceSelectionIndex] ?? activeSourceOptions[0];
      const firstMissingSecretIndex = source.secretInputs.findIndex((secret) =>
        needsEnvValue(secret),
      );
      setSelectedSourceId(source.id);
      setSourceState({ secretValues: {} });
      setSourceDescriptionSelectionIndex(0);
      setSecretInputIndex(
        firstMissingSecretIndex === -1 ? 0 : firstMissingSecretIndex,
      );
      setInput("");
      setCronModeSelectionIndex(0);
      setPowerModeSelectionIndex(0);
      setCronFieldSelectionIndex(0);
      setCronReplaceCurrentField(true);

      if (
        source.secretInputs.some((secretInput) => needsEnvValue(secretInput))
      ) {
        setStep("source-secret");
        return;
      }

      continueAfterSourceCredentialSetup(source);
      return;
    }

    if (step === "source-secret") {
      const currentSecretInput = selectedSource.secretInputs[secretInputIndex];
      if (!currentSecretInput) {
        continueAfterSourceCredentialSetup(selectedSource);
        return;
      }

      const trimmedInput = input.trim();
      if (trimmedInput.length === 0 && !currentSecretInput.optional) {
        setError(`${currentSecretInput.envKey} is required.`);
        return;
      }

      const nextSecretValues = {
        ...sourceState.secretValues,
        ...(trimmedInput.length > 0
          ? { [currentSecretInput.envKey]: trimmedInput }
          : {}),
      };
      setSourceState((state) => ({
        ...state,
        secretValues: nextSecretValues,
      }));
      setInput("");

      const nextIndex = secretInputIndex + 1;
      const nextMissingIndex = selectedSource.secretInputs.findIndex(
        (secretInput, index) =>
          index >= nextIndex &&
          needsEnvValue(secretInput) &&
          nextSecretValues[secretInput.envKey] === undefined,
      );

      if (nextMissingIndex !== -1) {
        setSecretInputIndex(nextMissingIndex);
        return;
      }

      await saveOpenWikiEnv(nextSecretValues);
      continueAfterSourceCredentialSetup(selectedSource);
      return;
    }

    if (step === "source-auth") {
      await authorizeSelectedSource();
      return;
    }

    if (step === "source-path") {
      const repoPath = normalizeLocalPath(input);

      if (repoPath.length === 0) {
        setError("Enter a local repository directory.");
        return;
      }

      try {
        const connectorConfig = await configureLocalGitRepo(repoPath);
        setSourceState((state) => ({ ...state, connectorConfig }));
        setInput("");
        setStep("source-description");
      } catch (setupError) {
        setError(getErrorMessage(setupError));
      }
      return;
    }

    if (step === "source-langsmith-workspaces") {
      const workspaceCount = langsmithWorkspaces.length;
      if (langsmithWorkspaceSelectionIndex < workspaceCount) {
        // Edit an existing workspace: load it into the draft and walk the fields.
        const existing = langsmithWorkspaces[langsmithWorkspaceSelectionIndex];
        setLangsmithEditingIndex(langsmithWorkspaceSelectionIndex);
        setLangsmithDraft({ ...existing });
        setLangsmithRegionSelectionIndex(
          getLangsmithRegionSelectionIndex(existing.region),
        );
        setStep("source-langsmith-region");
        return;
      }
      if (langsmithWorkspaceSelectionIndex === workspaceCount) {
        // Add a workspace with a fresh key env var name.
        setLangsmithEditingIndex(workspaceCount);
        setLangsmithDraft({
          apiKey: "",
          apiKeyEnv: nextLangSmithApiKeyEnv(
            langsmithWorkspaces.map((workspace) => workspace.apiKeyEnv),
          ),
          projects: [],
          region: "us",
        });
        setLangsmithRegionSelectionIndex(
          getLangsmithRegionSelectionIndex("us"),
        );
        setStep("source-langsmith-region");
        return;
      }
      // Done.
      returnToSourceMenu();
      return;
    }

    if (step === "source-langsmith-region") {
      const selectedOption =
        LANGSMITH_REGION_OPTIONS[langsmithRegionSelectionIndex] ??
        LANGSMITH_REGION_OPTIONS[0];
      setLangsmithDraft((draft) =>
        draft ? { ...draft, region: selectedOption.id } : draft,
      );
      seedInputForStep("source-langsmith-key");
      setStep("source-langsmith-key");
      return;
    }

    if (step === "source-langsmith-key") {
      const nextKey = input.trim();
      setLangsmithDraft((draft) =>
        draft ? { ...draft, apiKey: nextKey } : draft,
      );
      // setLangsmithDraft has not applied yet this tick, so seed the projects
      // field from the current draft rather than via seedInputForStep.
      setInput((langsmithDraft?.projects ?? []).join(", "));
      setStep("source-langsmith-projects");
      return;
    }

    if (step === "source-langsmith-projects") {
      // Commit the workspace with its exact project set; nothing is written here,
      // the file + keys are committed at the final step.
      const names = [
        ...new Set(
          input
            .split(",")
            .map((name) => name.trim())
            .filter((name) => name.length > 0),
        ),
      ];
      commitLangsmithWorkspace(names);
      returnToWorkspacesMenu();
      return;
    }

    if (step === "source-description") {
      if (sourceDescriptionSelectionIndex >= selectedSource.examples.length) {
        setInput("");
        setStep("source-description-custom");
        return;
      }

      const selectedExample =
        selectedSource.examples[sourceDescriptionSelectionIndex] ?? "";
      await saveSelectedSourceDescription(selectedExample);
      return;
    }

    if (step === "source-description-custom") {
      await saveSelectedSourceDescription(input.trim());
      return;
    }

    if (step === "global-cron-mode") {
      const selectedMode = CRON_MODE_OPTIONS[cronModeSelectionIndex];

      if (selectedMode === "Enter custom cron") {
        setInput(suggestedCronExpression);
        setCronFieldSelectionIndex(0);
        setCronReplaceCurrentField(true);
        setStep("global-cron-custom");
        return;
      }

      await saveModeSchedule(suggestedCronExpression);
      return;
    }

    if (step === "global-cron-custom") {
      const validation = validateCronExpression(input);

      if (!validation.valid) {
        setError(validation.error);
        return;
      }

      await saveModeSchedule(validation.expression);
      return;
    }

    if (step === "global-power-mode") {
      const selectedMode = POWER_MODE_OPTIONS[powerModeSelectionIndex];

      if (selectedMode === "Set up Mac wake/sleep window") {
        await saveGlobalMacPowerWindow();
        return;
      }

      setSourceSelectionIndex(0);
      setSourceState({ secretValues: {} });
      setInput("");
      setStep("source-menu");
      return;
    }

    if (step === "source-confirm-continue") {
      const selectedAction =
        SOURCE_CONTINUE_OPTIONS[sourceContinueSelectionIndex];
      if (selectedAction === "Go back to connections") {
        returnToSourceMenu();
        setStep("source-menu");
        return;
      }

      setStep("final");
      return;
    }

    if (step === "final") {
      // Commit the LangSmith workspaces as the exact set (WYSIWYG add/edit/remove),
      // only when the sub-menu was opened — so an aborted or untouched setup never
      // rewrites openwiki/.langsmith.json.
      if (selectedMode === "code" && langsmithSourcesTouched) {
        try {
          // Freshly-entered keys go to ~/.openwiki/.env (never committed); an empty
          // apiKey keeps the existing saved key.
          const keyUpdates: Record<string, string> = {};
          for (const workspace of langsmithWorkspaces) {
            if (workspace.apiKey.length > 0) {
              keyUpdates[workspace.apiKeyEnv] = workspace.apiKey;
            }
          }
          if (Object.keys(keyUpdates).length > 0) {
            await saveOpenWikiEnv(keyUpdates);
          }
          await saveLangSmithSetup(
            codeRepoRoot,
            langsmithWorkspaces.map((workspace) => ({
              apiKeyEnv: workspace.apiKeyEnv,
              projects: workspace.projects,
              region: workspace.region,
            })),
          );
        } catch (writeError) {
          setError(getErrorMessage(writeError));
          return;
        }
      }
      const runIngestionNow =
        FINAL_OPTIONS[finalSelectionIndex] === "Run ingestion now";
      const nextConfig = {
        ...onboardingConfig,
        completedAt: new Date().toISOString(),
      };
      await saveConfigForCurrentMode(nextConfig);
      onComplete({
        mode: selectedMode,
        modelId:
          modelId ??
          modelIdOverride ??
          process.env[OPENWIKI_MODEL_ID_ENV_KEY] ??
          null,
        onboardingCompleted: true,
        provider,
        repoRoot:
          selectedMode === "code" && codeRepoConfirmed
            ? codeRepoRoot
            : undefined,
        runIngestionNow,
        savedApiKey: apiKey !== null || oauthTokens !== null,
        savedBaseUrl: baseUrl !== null,
        savedGcpLocation: gcpLocation !== null,
        savedGcpProject: gcpProject !== null,
        savedLangSmithKey: langSmithKey !== null && langSmithKey.length > 0,
        savedModelId: modelId !== null,
        savedProvider: process.env[OPENWIKI_PROVIDER_ENV_KEY] !== provider,
        savedRegion: region !== null,
        savedSecretKey: secretKey !== null,
        shouldContinueToRun: runIngestionNow,
      });
    }
  }

  async function saveSelectedSourceDescription(description: string) {
    const connectorConfig =
      selectedSourceId === "web-search" || selectedSourceId === "hackernews"
        ? getStaticSourceConfig(selectedSourceId, description)
        : sourceState.connectorConfig;

    const sourceInstanceId = createSourceInstanceId(
      selectedSourceId,
      onboardingConfig,
    );
    const sourceInstance = {
      connectedAt: new Date().toISOString(),
      connectorConfig,
      connectorId: selectedSourceId,
      id: sourceInstanceId,
      ingestionGoal: description.length > 0 ? description : undefined,
      name: createSourceInstanceName(
        selectedSource,
        description,
        onboardingConfig,
      ),
    };
    const nextConfig = addSourceInstanceConfig(
      onboardingConfig,
      sourceInstance,
    );
    await saveConfig(nextConfig);
    setSourceState((state) => ({
      ...state,
      connectorConfig,
    }));
    setInput("");
    returnToSourceMenu();
  }

  type CompleteSetupOptions = {
    nextApiKey: string | null;
    nextBaseUrl: string | null;
    nextGcpLocation: string | null;
    nextGcpProject: string | null;
    nextLangSmithKey: string | null;
    nextModelId: string | null;
    nextOAuthTokens?: CodexTokens | null;
    nextProvider: OpenWikiProvider;
    nextRegion: string | null;
    nextSecretKey: string | null;
    runMode: OpenWikiRunMode;
  };

  async function continueAfterCredentials(options: CompleteSetupOptions) {
    await saveCredentialUpdates(options);

    // Explicit --init walks the whole tail; enter at its first step rather than
    // skipping steps that are already configured.
    if (walkAllSteps) {
      if (options.runMode === "code") {
        setCodeRepoRoot(getDefaultCodeRepoRootPath());
        setCodeRepoSelectionIndex(0);
        setStep("code-repo-confirm");
        return;
      }

      // Personal mode fixes the template from the run mode, so skip the
      // redundant Code/Personal chooser and walk straight into the wiki brief.
      // Seed the existing goal so Enter keeps it (idempotent re-walk), else the
      // template's suggested goal.
      setInput(
        onboardingConfig.wikiGoal ??
          getTemplateGoal(getConfigModeId(onboardingConfig)),
      );
      setStep("wiki-goal");
      return;
    }

    if (options.runMode === "code" && !isOnboardingComplete(onboardingConfig)) {
      setCodeRepoRoot(getDefaultCodeRepoRootPath());
      setCodeRepoSelectionIndex(0);
      setStep("code-repo-confirm");
      return;
    }

    if (!getConfigModeId(onboardingConfig)) {
      setStep("template");
      return;
    }

    if (!onboardingConfig.wikiGoal) {
      setInput(getTemplateGoal(getConfigModeId(onboardingConfig)));
      setStep("wiki-goal");
      return;
    }

    if (!onboardingConfig.ingestionSchedule) {
      setCronModeSelectionIndex(0);
      setStep("global-cron-mode");
      return;
    }

    if (!isOnboardingComplete(onboardingConfig)) {
      setStep("source-menu");
      return;
    }

    await completeSetup(options);
  }

  function continueAfterCodeRepoConfirmed(repoRoot: string) {
    setCodeRepoRoot(repoRoot);
    // Preload committed LangSmith projects (once) so the source menu shows them
    // and edits build on them (fail-open on the read).
    if (!langsmithPreloadedRef.current) {
      langsmithPreloadedRef.current = true;
      void loadLangSmithSetup(repoRoot)
        .then((existing) =>
          setLangsmithWorkspaces(
            existing.map((workspace) => ({
              apiKey: "",
              apiKeyEnv: workspace.apiKeyEnv,
              projects: workspace.projects,
              region: workspace.region,
            })),
          ),
        )
        .catch(() => {});
    }
    // Code mode auto-configures the repo itself; the source menu then offers the
    // optional LangSmith trace sources before the wiki brief.
    setSourceSelectionIndex(0);
    setSourceState({ secretValues: {} });
    setStep("source-menu");
  }

  // Continues past the code-mode source menu into the wiki brief. Walks wiki-goal
  // on --init even when set; otherwise only when unset. Seeds the existing goal so
  // Enter keeps it (idempotent).
  function advanceAfterCodeSources() {
    if (walkAllSteps || !onboardingConfig.wikiGoal) {
      setInput(
        onboardingConfig.wikiGoal ??
          getTemplateGoal(getConfigModeId(onboardingConfig)),
      );
      setStep("wiki-goal");
      return;
    }

    setStep("final");
  }

  async function completeSetup(options: CompleteSetupOptions) {
    await saveCredentialUpdates(options);

    onComplete({
      modelId:
        options.nextModelId ??
        modelIdOverride ??
        process.env[OPENWIKI_MODEL_ID_ENV_KEY] ??
        null,
      onboardingCompleted: isOnboardingComplete(onboardingConfig),
      provider: options.nextProvider,
      repoRoot:
        options.runMode === "code" && codeRepoConfirmed
          ? codeRepoRoot
          : undefined,
      mode: options.runMode,
      runIngestionNow: false,
      savedApiKey:
        options.nextApiKey !== null || options.nextOAuthTokens != null,
      savedBaseUrl: options.nextBaseUrl !== null,
      savedRegion: options.nextRegion !== null,
      savedSecretKey: options.nextSecretKey !== null,
      savedGcpLocation: options.nextGcpLocation !== null,
      savedGcpProject: options.nextGcpProject !== null,
      savedLangSmithKey:
        options.nextLangSmithKey !== null &&
        options.nextLangSmithKey.length > 0,
      savedModelId: options.nextModelId !== null,
      savedProvider:
        process.env[OPENWIKI_PROVIDER_ENV_KEY] !== options.nextProvider,
      shouldContinueToRun: true,
    });
  }

  async function saveCredentialUpdates({
    nextApiKey,
    nextBaseUrl,
    nextGcpLocation,
    nextGcpProject,
    nextLangSmithKey,
    nextModelId,
    nextOAuthTokens = oauthTokens,
    nextProvider,
    nextRegion,
    nextSecretKey,
  }: CompleteSetupOptions) {
    setIsSaving(true);

    try {
      const updates: Record<string, string> = {};

      if (process.env[OPENWIKI_PROVIDER_ENV_KEY] !== nextProvider) {
        updates[OPENWIKI_PROVIDER_ENV_KEY] = nextProvider;
      }

      if (nextApiKey !== null) {
        const apiKeyEnvKey = getProviderApiKeyEnvKey(nextProvider);

        if (apiKeyEnvKey) {
          updates[apiKeyEnvKey] = nextApiKey;
        }
      }

      if (nextOAuthTokens) {
        Object.assign(updates, codexTokensToEnv(nextOAuthTokens));
      }

      if (nextBaseUrl !== null) {
        const baseUrlEnvKey = getProviderBaseUrlEnvKey(nextProvider);

        if (baseUrlEnvKey) {
          updates[baseUrlEnvKey] = nextBaseUrl;
        }
      }

      if (nextSecretKey !== null) {
        const secretKeyEnvKey = getProviderSecretKeyEnvKey(nextProvider);

        if (secretKeyEnvKey) {
          updates[secretKeyEnvKey] = nextSecretKey;
        }
      }

      if (nextRegion !== null) {
        const regionEnvKey = getProviderRegionEnvKey(nextProvider);

        if (regionEnvKey) {
          updates[regionEnvKey] = nextRegion;
        }
      }

      if (nextGcpProject !== null) {
        const projectEnvKey = getProviderProjectEnvKey(nextProvider);

        if (projectEnvKey) {
          updates[projectEnvKey] = nextGcpProject;
        }
      }

      if (nextGcpLocation !== null) {
        const locationEnvKey = getProviderLocationEnvKey(nextProvider);

        if (locationEnvKey) {
          updates[locationEnvKey] = nextGcpLocation;
        }
      }

      if (nextModelId !== null) {
        updates[OPENWIKI_MODEL_ID_ENV_KEY] = nextModelId;
      }

      if (nextLangSmithKey !== null) {
        updates.LANGSMITH_API_KEY = nextLangSmithKey;

        if (nextLangSmithKey.length > 0) {
          updates.LANGCHAIN_PROJECT = "openwiki";
          updates.LANGCHAIN_TRACING_V2 = "true";
        } else {
          // Blank input must act as an off switch: without this, a
          // LANGCHAIN_TRACING_V2=true saved by an earlier setup stays in
          // ~/.openwiki/.env and tracing silently remains enabled.
          updates.LANGCHAIN_TRACING_V2 = "false";
        }
      }

      if (Object.keys(updates).length > 0) {
        await saveOpenWikiEnv(updates);
      }
    } catch (saveError) {
      onError(getErrorMessage(saveError));
    } finally {
      setIsSaving(false);
    }
  }

  async function authorizeSelectedSource() {
    setIsAuthRunning(true);
    setError(null);
    setNotice(null);

    try {
      if (selectedSource.id === "git-repo") {
        await configureLocalGitRepo();
      } else if (selectedSource.authProvider) {
        const authResult = await runOAuthAuth(selectedSource.authProvider, {
          onAuthorizationUrl: ({ copiedToClipboard, openedBrowser, url }) => {
            setSourceState((state) => ({
              ...state,
              authUrl: url,
              copiedAuthUrlToClipboard: copiedToClipboard,
            }));
            setNotice(
              openedBrowser
                ? "Opened browser for authorization. Complete the flow to continue."
                : copiedToClipboard
                  ? "Open the authorization URL from your clipboard to continue."
                  : "Open the authorization URL below to continue.",
            );
          },
          silent: true,
        });
        await configureAuthProvider(authResult.provider, { force: false });
      }

      setInput("");
      setStep("source-description");
    } catch (authError) {
      setError(getErrorMessage(authError));
    } finally {
      setIsAuthRunning(false);
    }
  }

  function continueAfterSourceCredentialSetup(source: SourceSetupOption) {
    if (source.authProvider) {
      setStep("source-auth");
      return;
    }

    if (source.id === "langsmith") {
      // Open the workspace sub-menu (add/edit/remove). Opening it arms the
      // WYSIWYG write on completion.
      setLangsmithSourcesTouched(true);
      setLangsmithWorkspaceSelectionIndex(0);
      setStep("source-langsmith-workspaces");
      return;
    }

    try {
      if (source.id === "git-repo") {
        setInput(getDefaultLocalGitRepoPath());
        setStep("source-path");
        return;
      } else if (source.id === "web-search" || source.id === "hackernews") {
        setSourceState((state) => ({
          ...state,
          connectorConfig: getStaticSourceConfig(source.id, ""),
        }));
      }

      setStep("source-description");
    } catch (setupError) {
      setError(getErrorMessage(setupError));
    }
  }

  /**
   * Folds the in-progress draft into langsmithWorkspaces at the editing index. An
   * empty project list removes the workspace (WYSIWYG).
   */
  function commitLangsmithWorkspace(names: string[]): void {
    const draft = langsmithDraft;
    setLangsmithWorkspaces((list) => {
      const next = [...list];
      if (names.length === 0) {
        if (langsmithEditingIndex < next.length) {
          next.splice(langsmithEditingIndex, 1);
        }
        return next;
      }
      if (!draft) {
        return next;
      }
      const workspace = { ...draft, projects: names };
      if (langsmithEditingIndex >= next.length) {
        next.push(workspace);
      } else {
        next[langsmithEditingIndex] = workspace;
      }
      return next;
    });
  }

  /**
   * Returns to the workspace sub-menu as a back-navigation: unwind history through
   * it so Esc from the refreshed sub-menu goes to the source menu, not back down
   * into the edited workspace's field steps.
   */
  function returnToWorkspacesMenu() {
    setInput("");
    setLangsmithDraft(null);
    const index = navHistory.current.lastIndexOf("source-langsmith-workspaces");
    if (index >= 0) {
      navHistory.current.length = index;
    }
    setStep("source-langsmith-workspaces", { back: true });
  }

  function returnToSourceMenu() {
    setSourceSelectionIndex(activeSourceOptions.length);
    setSourceState({ secretValues: {} });
    setInput("");
    // Returning to the menu is a back-navigation: unwind history through the menu
    // so Escape from the refreshed menu goes to the step BEFORE it (repo-confirm),
    // not back down into the source's child steps (which would show empty fields).
    const menuIndex = navHistory.current.lastIndexOf("source-menu");
    if (menuIndex >= 0) {
      navHistory.current.length = menuIndex;
    }
    setStep("source-menu", { back: true });
  }

  async function configureLocalGitRepo(
    repoPathInput = getDefaultLocalGitRepoPath(),
  ): Promise<Record<string, unknown>> {
    const sourceId = "git-repo";
    const repoPath = normalizeLocalPath(repoPathInput);
    const repoId = sanitizeRepoId(path.basename(repoPath) || "repo");
    const configPath = getConnectorConfigPath(sourceId);
    const connectorConfig = {
      repos: [
        {
          id: repoId,
          path: repoPath,
        },
      ],
    };
    await import("node:fs/promises").then(
      async ({ chmod, mkdir, stat, writeFile }) => {
        const repoStat = await stat(repoPath);
        if (!repoStat.isDirectory()) {
          throw new Error(`${repoPath} is not a directory.`);
        }

        await mkdir(path.dirname(configPath), {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(
          configPath,
          `${JSON.stringify(connectorConfig, null, 2)}\n`,
          {
            encoding: "utf8",
            mode: 0o600,
          },
        );
        await chmod(configPath, 0o600);
      },
    );
    return connectorConfig;
  }

  async function saveModeSchedule(cronExpression: string) {
    setIsSaving(true);

    try {
      const result = await installConnectorSchedule({
        connectorId: "git-repo",
        cronExpression,
        cwd: process.cwd(),
      });
      const nextConfig: OpenWikiOnboardingConfig = {
        ...onboardingConfig,
        ingestionSchedule: {
          description: result.description,
          expression: result.expression,
          launchAgentPath: result.launchAgentPath,
          updatedAt: new Date().toISOString(),
          warning: result.warning,
        },
      };
      await saveConfig(nextConfig);
      setSourceState((state) => ({
        ...state,
        savedScheduleWarning: result.warning,
      }));
      setPowerModeSelectionIndex(0);
      setStep("global-power-mode");
    } catch (scheduleError) {
      setError(getErrorMessage(scheduleError));
    } finally {
      setIsSaving(false);
    }
  }

  async function saveGlobalMacPowerWindow() {
    setIsSaving(true);

    try {
      const configForPower = await readOpenWikiOnboardingConfig();
      const result = await installOpenWikiPowerSchedule(configForPower);
      const nextConfig: OpenWikiOnboardingConfig = {
        ...configForPower,
        powerManagement: {
          ...configForPower.powerManagement,
          pmset: {
            days: result.days,
            enabled: result.enabled,
            sleepTime: result.sleepTime,
            updatedAt: new Date().toISOString(),
            wakeTime: result.wakeTime,
            warning: result.warning,
          },
        },
      };
      await saveConfig(nextConfig);
      setSourceSelectionIndex(0);
      setSourceState({
        secretValues: {},
        savedScheduleWarning: result.warning,
      });
      setInput("");
      setStep("source-menu");
    } catch (powerError) {
      setError(getErrorMessage(powerError));
    } finally {
      setIsSaving(false);
    }
  }

  async function saveConfig(config: OpenWikiOnboardingConfig) {
    setIsSaving(true);
    try {
      await saveOpenWikiOnboardingConfig(config);
      setOnboardingConfig(config);
    } catch (saveError) {
      onError(getErrorMessage(saveError));
    } finally {
      setIsSaving(false);
    }
  }

  async function saveConfigForCurrentMode(config: OpenWikiOnboardingConfig) {
    if (!isCodeMode(config)) {
      await saveConfig(config);
      return;
    }

    setIsSaving(true);
    try {
      if (config.wikiGoal?.trim()) {
        await saveRepositoryWikiInstructions(codeRepoRoot, config.wikiGoal);
      }
      await saveOpenWikiOnboardingConfig({
        ...config,
        wikiGoal: undefined,
      });
      setOnboardingConfig(config);
    } catch (saveError) {
      onError(getErrorMessage(saveError));
    } finally {
      setIsSaving(false);
    }
  }

  function submitManualLogin(pasted: string): void {
    const handle = loginHandleRef.current;

    if (!handle) {
      setError("Login is still starting. Try again in a moment.");
      return;
    }

    const errorMessage = handle.submitManual(pasted);

    if (errorMessage) {
      setError(errorMessage);
      return;
    }

    setInput("");
    setError(null);
  }

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
          <SetupStep
            label="LangSmith"
            state={resolveStepStatus(
              "langsmith",
              step,
              langSmithKey !== null || Boolean(process.env.LANGSMITH_API_KEY),
              "optional",
            )}
            detail={
              langSmithKey !== null
                ? langSmithKey.length > 0
                  ? "configured"
                  : "skipped"
                : process.env.LANGSMITH_API_KEY
                  ? "configured"
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

      {navHistory.current.length > 0 ? (
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

function Prompt({
  codeRepoPathInput,
  codeRepoRoot,
  codeRepoSelectionIndex,
  externalCliAuth,
  cronFieldSelectionIndex,
  cronModeSelectionIndex,
  finalSelectionIndex,
  input,
  inputDisplayWidth,
  isCustomModelInput,
  langsmithDraft,
  langsmithRegionSelectionIndex,
  langsmithWorkspaceSelectionIndex,
  langsmithWorkspaces,
  modelSelectionIndex,
  onboardingConfig,
  powerModeSelectionIndex,
  provider,
  providerSelectionIndex,
  runModeSelectionIndex,
  secretInputIndex,
  selectedMode,
  selectedSource,
  sourceOptions,
  sourceContinueSelectionIndex,
  sourceDescriptionSelectionIndex,
  sourceSelectionIndex,
  sourceState,
  step,
  suggestedCronDescription,
  suggestedCronExpression,
  templateSelectionIndex,
}: {
  codeRepoPathInput: string;
  codeRepoRoot: string;
  codeRepoSelectionIndex: number;
  externalCliAuth: ExternalCliAuthState;
  cronFieldSelectionIndex: number;
  cronModeSelectionIndex: number;
  finalSelectionIndex: number;
  input: string;
  inputDisplayWidth: number;
  isCustomModelInput: boolean;
  langsmithDraft: LangsmithWorkspaceDraft | null;
  langsmithRegionSelectionIndex: number;
  langsmithWorkspaceSelectionIndex: number;
  langsmithWorkspaces: LangsmithWorkspaceDraft[];
  modelSelectionIndex: number;
  onboardingConfig: OpenWikiOnboardingConfig;
  powerModeSelectionIndex: number;
  provider: OpenWikiProvider;
  providerSelectionIndex: number;
  runModeSelectionIndex: number;
  secretInputIndex: number;
  selectedMode: OpenWikiRunMode;
  selectedSource: SourceSetupOption;
  sourceOptions: readonly SourceSetupOption[];
  sourceContinueSelectionIndex: number;
  sourceDescriptionSelectionIndex: number;
  sourceSelectionIndex: number;
  sourceState: SourceSetupState;
  step: PromptStep;
  suggestedCronDescription: string;
  suggestedCronExpression: string;
  templateSelectionIndex: number;
}) {
  if (step === "run-mode") {
    const selectedMode =
      RUN_MODE_OPTIONS[runModeSelectionIndex] ?? RUN_MODE_OPTIONS[0];

    return (
      <Box flexDirection="column">
        <Text>Choose what OpenWiki should initialize.</Text>
        {RUN_MODE_OPTIONS.map((option, index) => (
          <Text key={option.id}>
            <SelectionMarker isSelected={index === runModeSelectionIndex} />{" "}
            {option.name} <Text color="gray">({option.id})</Text>
          </Text>
        ))}
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{selectedMode.name}</Text>
          <Text color="gray">{selectedMode.description}</Text>
        </Box>
        <Text color="gray">Use up/down arrows, then press Enter.</Text>
      </Box>
    );
  }

  if (step === "provider") {
    return (
      <Box flexDirection="column">
        <Text>Choose a model provider.</Text>
        {SELECTABLE_OPENWIKI_PROVIDERS.map((providerOption, index) => (
          <Text key={providerOption}>
            <SelectionMarker isSelected={index === providerSelectionIndex} />{" "}
            {getProviderLabel(providerOption)}
            <Text color="gray"> ({providerOption})</Text>
            {providerOption === DEFAULT_PROVIDER ? (
              <Text color="gray"> default</Text>
            ) : null}
          </Text>
        ))}
        <Text color="gray">Use up/down arrows, then press Enter.</Text>
      </Box>
    );
  }

  if (step === "api-key") {
    return (
      <Box flexDirection="column">
        <Text>Paste your {getApiKeyFieldLabel(provider)}.</Text>
        <BorderedInput
          maxDisplayWidth={inputDisplayWidth}
          marginTop={1}
          prefix={`${getProviderApiKeyEnvKey(provider)}=`}
          secret
          value={input}
        />
        <Text color="gray">Press Enter to save it.</Text>
      </Box>
    );
  }

  if (step === "external-cli-auth") {
    return (
      <ExternalCliAuthPrompt
        authState={externalCliAuth}
        input={input}
        provider={provider}
      />
    );
  }

  if (step === "secret-key") {
    return (
      <Box flexDirection="column">
        <Text>Paste your {getProviderLabel(provider)} secret access key.</Text>
        <BorderedInput
          maxDisplayWidth={inputDisplayWidth}
          marginTop={1}
          prefix={`${getProviderSecretKeyEnvKey(provider)}=`}
          secret
          value={input}
        />
        <Text color="gray">Press Enter to save it.</Text>
      </Box>
    );
  }

  if (step === "gcp-project") {
    return (
      <Box flexDirection="column">
        <Text>Enter the Google Cloud project ID with Vertex AI access.</Text>
        <Text>
          <Text color="gray">$</Text> {getProviderProjectEnvKey(provider)}={" "}
          <Text color="yellow">{input}</Text>
        </Text>
        <Text color="gray">
          OpenWiki authenticates with Google Application Default Credentials
          (run: gcloud auth application-default login). Press Enter to save it.
        </Text>
      </Box>
    );
  }

  if (step === "gcp-location") {
    return (
      <Box flexDirection="column">
        <Text>
          Enter a Vertex AI location, or press Enter to use{" "}
          {DEFAULT_VERTEX_LOCATION}.
        </Text>
        <Text>
          <Text color="gray">$</Text> {getProviderLocationEnvKey(provider)}={" "}
          <Text color="yellow">{input}</Text>
        </Text>
        <Text color="gray">
          For example global, europe-west1, or us-east5. Press Enter to
          continue.
        </Text>
      </Box>
    );
  }

  if (step === "base-url") {
    return (
      <Box flexDirection="column">
        <Text>Enter the {getProviderLabel(provider)} base URL.</Text>
        <Text>
          <Text color="gray">$</Text> {getProviderBaseUrlEnvKey(provider)}={" "}
          <Text color="yellow">{input}</Text>
        </Text>
        <Text color="gray">
          For example an OpenAI-compatible gateway endpoint (such as a LiteLLM
          gateway). Press Enter to save it.
        </Text>
      </Box>
    );
  }

  if (step === "region") {
    const resolvedRegion = resolveProviderRegion(provider);
    const credentialRepairMessage = getAwsCredentialRepairMessage(provider);

    return (
      <Box flexDirection="column">
        {credentialRepairMessage ? (
          <Text color="yellow">⚠ {credentialRepairMessage}</Text>
        ) : null}
        <Text>
          Enter the {getProviderLabel(provider)} region
          {resolvedRegion ? `, or press Enter to keep ${resolvedRegion}` : ""}.
        </Text>
        <Text>
          <Text color="gray">$</Text> {getProviderRegionEnvKey(provider)}={" "}
          <Text color="yellow">{input}</Text>
        </Text>
        <Text color="gray">
          Uses {getProviderRegionEnvKeys(provider).join(", ")}. For example
          us-east-1.
        </Text>
      </Box>
    );
  }

  if (step === "model") {
    if (isCustomModelInput) {
      return (
        <Box flexDirection="column">
          <Text>Paste a custom model ID.</Text>
          <BorderedInput
            maxDisplayWidth={inputDisplayWidth}
            marginTop={1}
            prefix={`${OPENWIKI_MODEL_ID_ENV_KEY}=`}
            value={input}
          />
          <Text color="gray">Press Enter to save it.</Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column">
        <Text>
          Choose {getProviderArticle(provider)} {getProviderLabel(provider)}{" "}
          model.
        </Text>
        {getModelSelectionOptions(provider).map((option, index) => {
          if (option.kind === "custom") {
            return (
              <Text key="custom">
                <SelectionMarker isSelected={index === modelSelectionIndex} />{" "}
                Custom model ID
              </Text>
            );
          }

          return (
            <Text key={option.id}>
              <SelectionMarker isSelected={index === modelSelectionIndex} />{" "}
              {option.label} <Text color="gray">{option.id}</Text>
              {option.id === getDefaultModelId(provider) ? (
                <Text color="gray"> default</Text>
              ) : null}
            </Text>
          );
        })}
        <Text color="gray">Use up/down arrows, then press Enter.</Text>
      </Box>
    );
  }

  if (step === "langsmith") {
    return (
      <Box flexDirection="column">
        <Text>Optional: paste a LangSmith API key for tracing.</Text>
        <BorderedInput
          maxDisplayWidth={inputDisplayWidth}
          marginTop={1}
          prefix="LANGSMITH_API_KEY optional="
          secret
          value={input}
        />
        <Text color="gray">Press Enter with an empty value to skip.</Text>
      </Box>
    );
  }

  if (step === "template") {
    const selectedTemplate =
      ONBOARDING_TEMPLATES[templateSelectionIndex] ?? ONBOARDING_TEMPLATES[0];

    return (
      <Box flexDirection="column">
        <Text>Choose how OpenWiki should run.</Text>
        {ONBOARDING_TEMPLATES.map((template, index) => (
          <Text key={template.id}>
            <SelectionMarker isSelected={index === templateSelectionIndex} />{" "}
            {template.name}
          </Text>
        ))}
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{selectedTemplate.name}</Text>
          <Text color="gray">{selectedTemplate.description}</Text>
          {selectedTemplate.suggestedSources.length > 0 ? (
            <Text color="gray">
              Suggested sources: {selectedTemplate.suggestedSources.join(", ")}
            </Text>
          ) : (
            <Text color="gray">Start from a blank wiki brief.</Text>
          )}
        </Box>
        <Text color="gray">
          Press Enter, then edit the brief on the next step.
        </Text>
      </Box>
    );
  }

  if (step === "wiki-goal") {
    return (
      <Box flexDirection="column">
        <Text>Customize what this wiki should understand.</Text>
        {getConfigModeName(onboardingConfig) ? (
          <Text color="gray">Mode: {getConfigModeName(onboardingConfig)}</Text>
        ) : null}
        <Text color="gray">
          Edit the brief below. Keep what is useful, delete what is not.
        </Text>
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Edit wiki brief</Text>
          <BorderedMultilineInput
            maxDisplayWidth={inputDisplayWidth}
            value={input}
          />
        </Box>
        <Text color="gray">Press Enter to continue.</Text>
      </Box>
    );
  }

  if (step === "code-repo-confirm") {
    return (
      <Box flexDirection="column">
        <Text>Use this repository?</Text>
        <Box marginTop={1}>
          <Text color="cyan">{codeRepoRoot}</Text>
        </Box>
        <Text color="gray">
          OpenWiki will run in this directory and write the initial openwiki/
          folder there.
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {CODE_REPO_OPTIONS.map((option, index) => (
            <Text key={option}>
              <SelectionMarker isSelected={index === codeRepoSelectionIndex} />{" "}
              {option}
            </Text>
          ))}
        </Box>
        <Text color="gray">Use up/down arrows, then press Enter.</Text>
      </Box>
    );
  }

  if (step === "code-repo-path") {
    return (
      <Box flexDirection="column">
        <Text>Choose the repository directory.</Text>
        <Text color="gray">
          Enter an existing directory. OpenWiki will write openwiki/ there.
        </Text>
        <BorderedInput
          maxDisplayWidth={inputDisplayWidth}
          marginTop={1}
          prefix="path="
          value={codeRepoPathInput}
        />
        <Text color="gray">Press Enter to confirm this path.</Text>
      </Box>
    );
  }

  if (step === "source-menu") {
    // LangSmith workspaces live in state until setup completes (not onboarding
    // source instances), so count them here for the menu's configured display.
    const langsmithWorkspaceCount = sourceOptions.some(
      (source) => source.id === "langsmith",
    )
      ? langsmithWorkspaces.length
      : 0;
    const configuredCount =
      getConnectedSourceCount(onboardingConfig, sourceOptions) +
      langsmithWorkspaceCount;

    return (
      <Box flexDirection="column">
        <Text>Configure sources for this mode.</Text>
        {sourceOptions.map((source, index) => {
          const isLangsmith = source.id === "langsmith";
          const sourceInstances = getSourceInstances(
            onboardingConfig,
            source.id,
          );
          const count = isLangsmith
            ? langsmithWorkspaces.length
            : sourceInstances.length;
          return (
            <Box flexDirection="column" key={source.id}>
              <Text>
                <SelectionMarker isSelected={index === sourceSelectionIndex} />{" "}
                {getSourceMenuLabel(source, count)}{" "}
                <SourceConnectionStatus
                  count={count}
                  isConfigured={count > 0}
                />
              </Text>
              {isLangsmith
                ? langsmithWorkspaces.map((workspace) => (
                    <Text color="gray" key={workspace.apiKeyEnv}>
                      {"  "}- {getLangsmithRegionLabel(workspace.region)}:{" "}
                      {workspace.projects.join(", ")}
                    </Text>
                  ))
                : sourceInstances.map((sourceInstance) => (
                    <Text color="gray" key={sourceInstance.id}>
                      {"  "}- {sourceInstance.name ?? sourceInstance.id}{" "}
                      <Text color="gray">({sourceInstance.id})</Text>
                    </Text>
                  ))}
            </Box>
          );
        })}
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">Next</Text>
          <Text>
            <SelectionMarker
              isSelected={sourceSelectionIndex === sourceOptions.length}
            />{" "}
            Continue{" "}
            {configuredCount === 0 ? (
              <Text color="gray">(no sources configured)</Text>
            ) : null}
          </Text>
        </Box>
        <Text color="gray">Use up/down arrows, then press Enter.</Text>
      </Box>
    );
  }

  if (step === "source-path") {
    return (
      <Box flexDirection="column">
        <Text>Choose the local Git repository directory.</Text>
        <Text color="gray">
          Default is the directory where you started OpenWiki. Edit it to use a
          different checkout.
        </Text>
        <BorderedInput
          maxDisplayWidth={inputDisplayWidth}
          marginTop={1}
          prefix="path="
          value={input}
        />
        <Text color="gray">Press Enter to save this source.</Text>
      </Box>
    );
  }

  if (step === "source-secret") {
    const secretInput = selectedSource.secretInputs[secretInputIndex];
    return (
      <Box flexDirection="column">
        <Text>{selectedSource.displayName} setup</Text>
        {selectedSource.instructions.map((instruction, index) => (
          <Text key={instruction}>
            {index + 1}. {instruction}
          </Text>
        ))}
        {secretInput ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Enter credential</Text>
            <BorderedInput
              maxDisplayWidth={inputDisplayWidth}
              prefix={`${secretInput.envKey}${
                secretInput.optional ? " optional" : ""
              }=`}
              secret
              value={input}
            />
            <Text color="gray">
              {secretInput.optional
                ? "Press Enter with an empty value to skip."
                : "Press Enter to save this value."}
            </Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  if (step === "source-auth") {
    return (
      <Box flexDirection="column">
        <Text>{selectedSource.displayName} authorization</Text>
        {sourceState.authUrl ? (
          <OAuthAuthorizationLink
            authProvider={selectedSource.authProvider}
            copiedToClipboard={Boolean(sourceState.copiedAuthUrlToClipboard)}
            url={sourceState.authUrl}
          />
        ) : (
          <Text color="gray">
            Press Enter to open the authorization URL and wait for the callback.
          </Text>
        )}
      </Box>
    );
  }

  if (step === "source-description") {
    return (
      <Box flexDirection="column">
        <Text>{getSourceDescriptionPrompt(selectedSource)}</Text>
        <Text color="gray">
          Choose an example description, or write your own.
        </Text>
        {selectedSource.examples.map((example, index) => (
          <Text key={example}>
            <SelectionMarker
              isSelected={index === sourceDescriptionSelectionIndex}
            />{" "}
            {example}
          </Text>
        ))}
        <Text>
          <SelectionMarker
            isSelected={
              sourceDescriptionSelectionIndex >= selectedSource.examples.length
            }
          />{" "}
          Custom description
        </Text>
        <Text color="gray">Use up/down arrows, then press Enter.</Text>
      </Box>
    );
  }

  if (step === "source-description-custom") {
    return (
      <Box flexDirection="column">
        <Text>{getSourceDescriptionPrompt(selectedSource)}</Text>
        <Text color="gray">
          Type what OpenWiki should focus on for this source.
        </Text>
        <BorderedMultilineInput
          maxDisplayWidth={inputDisplayWidth}
          marginTop={1}
          value={input}
        />
        <Text color="gray">Optional. Press Enter to continue.</Text>
      </Box>
    );
  }

  if (step === "source-langsmith-workspaces") {
    const workspaceCount = langsmithWorkspaces.length;
    return (
      <Box flexDirection="column">
        <Text>LangSmith workspaces to document.</Text>
        <Text color="gray">
          A LangSmith key is region-bound, so each workspace has its own region
          and key. Select one to edit (clear its projects to remove it).
        </Text>
        {langsmithWorkspaces.map((workspace, index) => (
          <Text key={workspace.apiKeyEnv}>
            <SelectionMarker
              isSelected={index === langsmithWorkspaceSelectionIndex}
            />{" "}
            {getLangsmithRegionLabel(workspace.region)}:{" "}
            {workspace.projects.join(", ")}
          </Text>
        ))}
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <SelectionMarker
              isSelected={langsmithWorkspaceSelectionIndex === workspaceCount}
            />{" "}
            Add a workspace
          </Text>
          <Text>
            <SelectionMarker
              isSelected={
                langsmithWorkspaceSelectionIndex === workspaceCount + 1
              }
            />{" "}
            Done
          </Text>
        </Box>
        <Text color="gray">Use up/down arrows, then press Enter.</Text>
      </Box>
    );
  }

  if (step === "source-langsmith-key") {
    const apiKeyEnv = langsmithDraft?.apiKeyEnv ?? "OPENWIKI_LANGSMITH_API_KEY";
    return (
      <Box flexDirection="column">
        <Text>LangSmith API key for this workspace.</Text>
        <Text color="gray">
          The connector&apos;s own read key (not your app&apos;s tracing key).
          Saved to ~/.openwiki/.env as {apiKeyEnv}, never committed.
        </Text>
        <BorderedInput
          maxDisplayWidth={inputDisplayWidth}
          marginTop={1}
          prefix={`${apiKeyEnv}=`}
          secret
          value={input}
        />
        <Text color="gray">
          Press Enter to confirm (empty keeps the saved key).
        </Text>
      </Box>
    );
  }

  if (step === "source-langsmith-projects") {
    return (
      <Box flexDirection="column">
        <Text>Which projects should this wiki document in this workspace?</Text>
        <Text color="gray">
          Comma-separated project names (as in LANGCHAIN_PROJECT). Written to
          openwiki/.langsmith.json.
        </Text>
        <BorderedMultilineInput
          maxDisplayWidth={inputDisplayWidth}
          marginTop={1}
          value={input}
        />
        <Text color="gray">Press Enter to confirm.</Text>
      </Box>
    );
  }

  if (step === "source-langsmith-region") {
    const selectedRegion =
      LANGSMITH_REGION_OPTIONS[langsmithRegionSelectionIndex] ??
      LANGSMITH_REGION_OPTIONS[0];

    return (
      <Box flexDirection="column">
        <Text>Which LangSmith region is this workspace in?</Text>
        {LANGSMITH_REGION_OPTIONS.map((option, index) => (
          <Text key={option.id}>
            <SelectionMarker
              isSelected={index === langsmithRegionSelectionIndex}
            />{" "}
            {option.name} <Text color="gray">({option.host})</Text>
          </Text>
        ))}
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">{selectedRegion.description}</Text>
        </Box>
        <Text color="gray">Use up/down arrows, then press Enter.</Text>
      </Box>
    );
  }

  if (step === "global-cron-mode") {
    return (
      <Box flexDirection="column">
        <Text>
          {isCodeMode(onboardingConfig)
            ? "When should GitHub Actions refresh this code wiki?"
            : "When should OpenWiki run all ingestion?"}
        </Text>
        <Text color="gray">
          {isCodeMode(onboardingConfig)
            ? "OpenWiki will write a scheduled GitHub Actions workflow for this repository."
            : "All configured sources run sequentially at this time."}
        </Text>
        <Text color="gray">Suggested: {suggestedCronDescription}</Text>
        {CRON_MODE_OPTIONS.map((option, index) => (
          <Text key={option}>
            <SelectionMarker isSelected={index === cronModeSelectionIndex} />{" "}
            {option}
          </Text>
        ))}
        <Text color="gray">Use up/down arrows, then press Enter.</Text>
      </Box>
    );
  }

  if (step === "global-cron-custom") {
    const validation = validateCronExpression(input);
    return (
      <Box flexDirection="column">
        <Text>
          {isCodeMode(onboardingConfig)
            ? "Enter one GitHub Actions cron schedule for this code wiki."
            : "Enter one cron schedule for all ingestion."}
        </Text>
        <SegmentedCronInput
          activeFieldIndex={cronFieldSelectionIndex}
          expression={input}
          fallbackExpression={suggestedCronExpression}
          maxDisplayWidth={inputDisplayWidth}
        />
        {input ? (
          <Text color={validation.valid ? "cyan" : "red"}>
            {validation.valid ? validation.description : validation.error}
          </Text>
        ) : (
          <Text color="gray">Example: 0 2 * * *</Text>
        )}
        <Text color="gray">
          Type in each field. Use right/left arrows or Tab to move; spaces also
          move fields.
        </Text>
        <Text color="gray">Press Enter to save a valid schedule.</Text>
      </Box>
    );
  }

  if (step === "global-power-mode") {
    return (
      <Box flexDirection="column">
        <Text>Keep your Mac awake for scheduled refreshes?</Text>
        <Text color="gray">
          OpenWiki can use macOS pmset to wake 2 minutes before the shared
          ingestion schedule and sleep 30 minutes after it.
        </Text>
        {sourceState.savedScheduleWarning ? (
          <Text color="yellow">{sourceState.savedScheduleWarning}</Text>
        ) : null}
        <Box flexDirection="column" marginTop={1}>
          {POWER_MODE_OPTIONS.map((option, index) => (
            <Text key={option}>
              <SelectionMarker isSelected={index === powerModeSelectionIndex} />{" "}
              {option}
            </Text>
          ))}
        </Box>
        <Text color="gray">
          macOS has one global repeat power schedule. Setting this can replace
          an existing pmset repeat wake/sleep schedule.
        </Text>
      </Box>
    );
  }

  if (step === "source-confirm-continue") {
    const missingSources = sourceOptions.filter(
      (source) => getSourceInstanceCount(onboardingConfig, source.id) === 0,
    );
    return (
      <Box flexDirection="column">
        <Text>Some sources for this mode are not configured yet.</Text>
        {missingSources.map((source) => (
          <Text color="gray" key={source.id}>
            - {source.displayName}
          </Text>
        ))}
        <Box flexDirection="column" marginTop={1}>
          {SOURCE_CONTINUE_OPTIONS.map((option, index) => (
            <Text key={option}>
              <SelectionMarker
                isSelected={index === sourceContinueSelectionIndex}
              />{" "}
              {option}
            </Text>
          ))}
        </Box>
        <Text color="gray">Use up/down arrows, then press Enter.</Text>
      </Box>
    );
  }

  if (step === "final") {
    return (
      <Box flexDirection="column">
        <Text>Setup is complete.</Text>
        {FINAL_OPTIONS.map((option, index) => {
          const label = getFinalOptionLabel(option, selectedMode);
          return (
            <Text key={option}>
              <SelectionMarker isSelected={index === finalSelectionIndex} />{" "}
              {label}
            </Text>
          );
        })}
        <Text color="gray">
          {selectedMode === "code"
            ? "Run now writes the initial openwiki/ directory. Open chat skips the initial run."
            : "Run now executes one source-specific ingestion and wiki update per configured source. Run later opens chat so you can start ingestion when you are ready."}
        </Text>
      </Box>
    );
  }

  return null;
}

function ExternalCliAuthPrompt({
  authState,
  input,
  provider,
}: {
  authState: ExternalCliAuthState;
  input: string;
  provider: OpenWikiProvider;
}) {
  const adapter = getExternalCliAuthAdapter(provider);
  const envKey = getProviderApiKeyEnvKey(provider) ?? "API key";

  if (!adapter) {
    return null;
  }

  if (authState.kind === "idle" || authState.kind === "checking") {
    return (
      <Text color="gray">
        Checking for an existing {adapter.credentialDescription}...
      </Text>
    );
  }

  if (authState.kind === "logging-in") {
    return (
      <Text color="gray">
        Running `{adapter.loginCommand}` — follow the prompts in this
        terminal...
      </Text>
    );
  }

  if (authState.kind === "detected") {
    return (
      <Box flexDirection="column">
        <Text>Detected an existing {adapter.credentialDescription}.</Text>
        <Text color="gray">
          Press Enter to use it, Tab to sign in again, or paste a different
          token below.
        </Text>
        <Text>
          <Text color="gray">$</Text> {envKey}={" "}
          <Text color="yellow">
            {input.length > 0 ? mask(input) : `<from ${adapter.name}>`}
          </Text>
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>No {adapter.credentialDescription} detected.</Text>
      {authState.kind === "login-failed" ? (
        <Text color="red">
          `{adapter.loginCommand}` did not complete successfully.
        </Text>
      ) : null}
      {authState.kind === "not-detected" && authState.cliAvailable ? (
        <Text color="gray">
          Press Tab to run `{adapter.loginCommand}`, or paste a token below.
        </Text>
      ) : (
        <Text color="gray">
          {adapter.installHint} You can also paste a token below for CI or other
          headless use.
        </Text>
      )}
      <Text>
        <Text color="gray">$</Text> {envKey}={" "}
        <Text color="yellow">{mask(input)}</Text>
      </Text>
      <Text color="gray">Press Enter to save it.</Text>
    </Box>
  );
}

function SetupHeader() {
  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      marginBottom={1}
      paddingX={1}
    >
      <Text>
        <Text bold color="cyan">
          OpenWiki
        </Text>{" "}
        <Text color="gray">first-run setup</Text>
      </Text>
      <Text>Configure the model, wiki scope, and sources.</Text>
    </Box>
  );
}

function SetupStep({
  detail,
  label,
  state,
}: {
  detail: string;
  label: string;
  state: SetupStepState;
}) {
  return (
    <Text>
      <Text color={STEP_COLOR[state]}>{STEP_GLYPH[state]}</Text>{" "}
      <Text bold={state === "current" || state === "done"}>
        {label.padEnd(16)}
      </Text>{" "}
      <Text color="gray">{detail}</Text>
    </Text>
  );
}

function SetupPanel({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      flexDirection="column"
      marginTop={1}
      paddingX={1}
    >
      <Text bold color="cyan">
        {title}
      </Text>
      {children}
    </Box>
  );
}

function SelectionMarker({ isSelected }: { isSelected: boolean }) {
  return (
    <Text color={isSelected ? "cyan" : "gray"}>{isSelected ? ">" : " "}</Text>
  );
}

function SourceConnectionStatus({
  count,
  isConfigured,
}: {
  count: number;
  isConfigured: boolean;
}) {
  return (
    <Text color={isConfigured ? "green" : "gray"}>
      {isConfigured
        ? `[configured${count > 1 ? ` x${count}` : ""}]`
        : "[not configured]"}
    </Text>
  );
}

function OAuthAuthorizationLink({
  authProvider,
  copiedToClipboard,
  url,
}: {
  authProvider?: AuthProviderId;
  copiedToClipboard: boolean;
  url: string;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color="cyan" underline>
          {formatTerminalHyperlink(url, "Open authorization URL")}
        </Text>
      </Text>
      <Text color={copiedToClipboard ? "green" : "gray"}>
        {getOAuthAuthorizationStatusText({
          authProvider,
          copiedToClipboard,
        })}
      </Text>
    </Box>
  );
}

function OAuthLoginPrompt({
  copied,
  input,
  isLoggingIn,
  loginUrl,
  provider,
}: {
  copied: boolean;
  input: string;
  isLoggingIn: boolean;
  loginUrl: string | null;
  provider: OpenWikiProvider;
}) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">
        ChatGPT login
      </Text>
      <Text>
        Sign in with your {getProviderLabel(provider)} account to authorize
        OpenWiki.
      </Text>
      {loginUrl ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">
            Opening your browser. If it does not open, copy this URL:
          </Text>
          <Text color="cyan" wrap="wrap">
            {loginUrl}
          </Text>
          <Text color="gray">
            Press <Text bold>c</Text> to copy the URL
            {copied ? <Text color="green"> (copied)</Text> : null}
          </Text>
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">
              If the browser cannot reach this machine, paste the redirect URL
              or authorization code and press Enter:
            </Text>
            <Text>
              <Text color="gray">&gt; </Text>
              {input.length > 0 ? (
                <Text color="yellow">{input}</Text>
              ) : (
                <Text color="gray">(paste here)</Text>
              )}
            </Text>
          </Box>
        </Box>
      ) : (
        <Text color="gray">Starting the ChatGPT login...</Text>
      )}
      <Text color="gray">
        {isLoggingIn
          ? "Waiting for browser sign-in or pasted URL..."
          : "Login failed. Press Enter to retry."}
      </Text>
    </Box>
  );
}

function BorderedInput({
  borderColor = "cyan",
  maxDisplayWidth,
  marginTop,
  prefix,
  secret = false,
  showCursor = true,
  value,
}: {
  borderColor?: "cyan" | "gray";
  maxDisplayWidth: number;
  marginTop?: number;
  prefix?: string;
  secret?: boolean;
  showCursor?: boolean;
  value: string;
}) {
  const prompt = prefix ? "$ " : "> ";
  const prefixText = prefix ? `${prefix} ` : "";
  const valueDisplayWidth = Math.max(
    1,
    maxDisplayWidth - prompt.length - prefixText.length - (showCursor ? 1 : 0),
  );

  return (
    <Box
      borderStyle="single"
      borderColor={borderColor}
      marginTop={marginTop}
      paddingX={1}
      width={maxDisplayWidth + 4}
    >
      <Text wrap="truncate">
        <Text color="gray">{prompt}</Text>
        {prefixText ? <Text color="gray">{prefixText}</Text> : null}
        <InputValueWithCursor
          maxDisplayWidth={valueDisplayWidth}
          secret={secret}
          showCursor={showCursor}
          value={value}
        />
      </Text>
    </Box>
  );
}

function BorderedMultilineInput({
  borderColor = "cyan",
  maxDisplayWidth,
  marginTop,
  showCursor = true,
  value,
}: {
  borderColor?: "cyan" | "gray";
  maxDisplayWidth: number;
  marginTop?: number;
  showCursor?: boolean;
  value: string;
}) {
  return (
    <Box
      borderStyle="single"
      borderColor={borderColor}
      flexDirection="column"
      marginTop={marginTop}
      paddingX={1}
      width={maxDisplayWidth + 4}
    >
      <Text wrap="wrap">
        <Text color="gray">&gt; </Text>
        {value ? <Text color="yellow">{value}</Text> : null}
        {showCursor ? <Text inverse> </Text> : null}
      </Text>
    </Box>
  );
}

function InputValueWithCursor({
  maxDisplayWidth,
  secret = false,
  showCursor = true,
  value,
}: {
  maxDisplayWidth: number;
  secret?: boolean;
  showCursor?: boolean;
  value: string;
}) {
  if (secret) {
    const displayValue = getSingleLineInputDisplayValue(
      formatSecretInputDisplay(value),
      maxDisplayWidth,
    );

    return (
      <>
        <Text color={value.length > 0 ? "yellow" : "gray"}>{displayValue}</Text>
        {showCursor ? <Text inverse> </Text> : null}
      </>
    );
  }

  const displayValue = getSingleLineInputDisplayValue(value, maxDisplayWidth);

  return (
    <>
      {displayValue ? <Text color="yellow">{displayValue}</Text> : null}
      {showCursor ? <Text inverse> </Text> : null}
    </>
  );
}

function SegmentedCronInput({
  activeFieldIndex,
  expression,
  fallbackExpression,
  maxDisplayWidth,
}: {
  activeFieldIndex: number;
  expression: string;
  fallbackExpression: string;
  maxDisplayWidth: number;
}) {
  const fields = getCronFields(expression, fallbackExpression);
  const fieldDisplayWidth = Math.max(
    8,
    Math.min(14, Math.floor(maxDisplayWidth / CRON_FIELD_LABELS.length) - 1),
  );

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        {fields.map((field, index) => (
          <Box
            flexDirection="column"
            marginRight={1}
            key={CRON_FIELD_LABELS[index]}
          >
            <Text color="gray">{CRON_FIELD_LABELS[index]}</Text>
            <BorderedInput
              borderColor={index === activeFieldIndex ? "cyan" : "gray"}
              maxDisplayWidth={fieldDisplayWidth}
              showCursor={index === activeFieldIndex}
              value={field}
            />
          </Box>
        ))}
      </Box>
      <Text color="gray">Cron: {fields.join(" ")}</Text>
    </Box>
  );
}

function needsEnvValue(secretInput: SourceSecretInput): boolean {
  return !process.env[secretInput.envKey];
}

function addSourceInstanceConfig(
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

function deriveLegacySources(
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

function getSourceInstanceCount(
  config: OpenWikiOnboardingConfig,
  sourceId: ConnectorId,
): number {
  return getSourceInstances(config, sourceId).length;
}

function getSourceInstances(
  config: OpenWikiOnboardingConfig,
  sourceId: ConnectorId,
): OpenWikiOnboardingConfig["sourceInstances"] {
  return config.sourceInstances.filter(
    (sourceInstance) => sourceInstance.connectorId === sourceId,
  );
}

function getConnectedSourceCount(
  config: OpenWikiOnboardingConfig,
  sourceOptions: readonly SourceSetupOption[],
): number {
  const sourceIds = new Set(sourceOptions.map((source) => source.id));
  return config.sourceInstances.filter((sourceInstance) =>
    sourceIds.has(sourceInstance.connectorId),
  ).length;
}

function createSourceInstanceId(
  sourceId: ConnectorId,
  config: OpenWikiOnboardingConfig,
): string {
  const sourceCount = getSourceInstanceCount(config, sourceId) + 1;
  return `${sourceId}-${sourceCount}`;
}

function createSourceInstanceName(
  source: SourceSetupOption,
  description: string,
  config: OpenWikiOnboardingConfig,
): string {
  const sourceCount = getSourceInstanceCount(config, source.id) + 1;
  const trimmedDescription = description.trim();
  const suffix = trimmedDescription.length > 0 ? `: ${trimmedDescription}` : "";
  return `${source.displayName} ${sourceCount}${suffix}`.slice(0, 120);
}

function isSourceStep(step: PromptStep | null): boolean {
  return Boolean(step?.startsWith("source-"));
}

function isScheduleStep(step: PromptStep | null): boolean {
  return Boolean(step?.startsWith("global-"));
}

/**
 * Label for the provider's primary credential input. Bedrock authenticates
 * with an IAM access key ID (paired with a secret access key), not a single
 * opaque API key, so its prompt reads differently from every other provider.
 */
function getApiKeyFieldLabel(provider: OpenWikiProvider): string {
  return provider === "bedrock"
    ? `${getProviderLabel(provider)} access key ID`
    : `${getProviderLabel(provider)} API key`;
}

function getModelSetupDetail(
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

function getModelSelectionOptions(
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

function shouldStartWithCustomModelInput(provider: OpenWikiProvider): boolean {
  return getProviderModelOptions(provider).length === 0;
}

function getSelectedModelId(
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

function getProviderSelectionIndex(provider: OpenWikiProvider): number {
  const selectedIndex = SELECTABLE_OPENWIKI_PROVIDERS.findIndex(
    (providerOption) => providerOption === provider,
  );

  return selectedIndex === -1 ? 0 : selectedIndex;
}

function getModelSelectionIndex(
  provider: OpenWikiProvider,
  selectedModelId: string,
): number {
  const selectedIndex = getModelSelectionOptions(provider).findIndex(
    (option) => option.kind === "preset" && option.id === selectedModelId,
  );

  return selectedIndex === -1 ? 0 : selectedIndex;
}

function moveSelectionIndex(
  currentIndex: number,
  offset: number,
  itemCount: number,
): number {
  if (itemCount <= 0) {
    return 0;
  }

  return (currentIndex + offset + itemCount) % itemCount;
}

function getInputDisplayWidth(stdoutColumns: number | undefined): number {
  const defaultWidth = 64;

  if (!stdoutColumns || stdoutColumns <= 0) {
    return defaultWidth;
  }

  return Math.max(24, Math.min(96, stdoutColumns - 16));
}

function getProviderArticle(provider: OpenWikiProvider): "a" | "an" {
  return provider === "baseten" ||
    provider === "fireworks" ||
    provider === "gemini" ||
    provider === "gemini-enterprise" ||
    provider === "nebius"
    ? "a"
    : "an";
}

function getTemplateGoal(templateId: string | undefined): string {
  return (
    ONBOARDING_TEMPLATES.find((template) => template.id === templateId)
      ?.suggestedGoal ?? ""
  );
}

function getSourceMenuLabel(
  source: SourceSetupOption,
  sourceInstanceCount: number,
): string {
  return sourceInstanceCount > 0
    ? `Add another ${source.displayName}`
    : `Add ${source.displayName}`;
}

function getTemplateSourceOptions(
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

function getSourceDescriptionPrompt(source: SourceSetupOption): string {
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

function getFinalOptionLabel(
  option: (typeof FINAL_OPTIONS)[number],
  mode: OpenWikiRunMode,
): string {
  if (mode !== "code") {
    return option;
  }

  return option === "Run ingestion now" ? "Run OpenWiki now" : "Open chat";
}

function getSourceDescriptionOptionCount(source: SourceSetupOption): number {
  return source.examples.length + 1;
}

function handleCronEditorInput({
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

function getCronFields(
  expression: string,
  fallbackExpression: string,
): string[] {
  const source =
    expression.trim().length > 0 ? expression.trim() : fallbackExpression;
  const fields = source.split(/\s+/u);

  return CRON_FIELD_LABELS.map((_, index) => fields[index] ?? "");
}

function parseCronFieldPaste(inputValue: string): string[] {
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

function sanitizeInputChunk(value: string): string {
  return value.replace(/[\r\n]/gu, "");
}

function sanitizeCronInputChunk(value: string): string {
  return value.replace(/[^A-Za-z0-9*,/?#LW.-]/gu, "");
}

function sanitizeRepoId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 80) || "repo";
}

function getDefaultLocalGitRepoPath(): string {
  return process.cwd();
}

async function validateLocalDirectoryPath(value: string): Promise<string> {
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

function normalizeLocalPath(value: string): string {
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

function getStaticSourceConfig(
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
