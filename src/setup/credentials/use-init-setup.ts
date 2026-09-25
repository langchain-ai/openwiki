import { useEffect, useMemo, useRef, useState } from "react";
import path from "node:path";
import { useInput, useStdin, useStdout } from "ink";
import { configureAuthProvider } from "../../auth/configure.js";
import { runOAuthAuth } from "../../auth/oauth.js";
import {
  DEFAULT_PROVIDER,
  DEFAULT_VERTEX_LOCATION,
  getDefaultModelId,
  getProviderApiKeyEnvKey,
  getProviderBaseUrlEnvKey,
  getProviderBaseUrlWarnings,
  getProviderLocationEnvKey,
  getProviderProjectEnvKey,
  getProviderRegionEnvKey,
  getProviderRegionEnvKeys,
  getProviderSecretKeyEnvKey,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
  OPENWIKI_REASONING_EFFORT_ENV_KEY,
  type OpenWikiProvider,
  providerUsesExternalCliAuth,
  resolveConfiguredProvider,
  resolveProviderRegion,
  SELECTABLE_OPENWIKI_PROVIDERS,
} from "../../config/constants.js";
import {
  type ChatGptLoginHandle,
  type CodexTokens,
  loginWithChatGPT,
} from "../../agent/openai-chatgpt-oauth.js";
import type { OpenWikiRunMode } from "../../cli/commands.js";
import {
  loadLangSmithSetup,
  nextLangSmithApiKeyEnv,
  saveLangSmithSetup,
} from "../../connectors/sources/langsmith/setup.js";
import type { ConnectorId } from "../../connectors/types.js";
import {
  detectExternalCliCredential,
  isExternalCliAvailable,
  runExternalCliLogin,
  type ExternalCliAuthState,
} from "../../auth/external-cli-auth.js";
import { getConnectorConfigPath } from "../../config/openwiki-home.js";
import { getSavedEnvValue, saveOpenWikiEnv } from "../../config/env.js";
import {
  createEmptyOnboardingConfig,
  isOnboardingComplete,
  readOpenWikiOnboardingConfig,
  saveRepositoryWikiInstructions,
  saveOpenWikiOnboardingConfig,
  type OpenWikiOnboardingConfig,
} from "../onboarding.js";
import {
  getSuggestedCronExpression,
  installOpenWikiPowerSchedule,
  installConnectorSchedule,
  validateCronExpression,
} from "../../scheduling/schedules.js";

import {
  addSourceInstanceConfig,
  createSourceInstanceId,
  createSourceInstanceName,
  ensureRunModeConfig,
  getConfigModeId,
  getConnectedSourceCount,
  getDefaultCodeRepoRootPath,
  getDefaultLocalGitRepoPath,
  getErrorMessage,
  getInitialStep,
  getInputDisplayWidth,
  getLangsmithRegionSelectionIndex,
  getModelSelectionIndex,
  getModelSelectionOptions,
  getReasoningEffortSelectionIndex,
  getReasoningEffortSelectionOptions,
  getNextStepAfterApiKey,
  getNextStepAfterBaseUrl,
  getNextStepAfterGcpLocation,
  getNextStepAfterProvider,
  getNextStepAfterRegion,
  getNextStepAfterSecretKey,
  getProviderSelectionIndex,
  getRunModeSelectionIndex,
  getSelectedModelId,
  getSourceDescriptionOptionCount,
  getSourceOption,
  getStaticSourceConfig,
  getTemplateGoal,
  getTemplateSourceOptions,
  handleCronEditorInput,
  hydrateRunModeConfig,
  isCodeMode,
  isCredentialConfigured,
  isSecretKeyConfigured,
  moveSelectionIndex,
  needsEnvValue,
  needsLangSmithStep,
  nextSetupStep,
  normalizeLocalPath,
  sanitizeInputChunk,
  sanitizeRepoId,
  shouldStartWithCustomModelInput,
  validateLocalDirectoryPath,
} from "./steps.js";
import {
  copyToClipboard,
  getAwsCredentialRepairMessage,
  openLoginUrl,
} from "./format.js";
import {
  CODE_REPO_OPTIONS,
  CRON_MODE_OPTIONS,
  FINAL_OPTIONS,
  LANGSMITH_REGION_OPTIONS,
  ONBOARDING_TEMPLATES,
  POWER_MODE_OPTIONS,
  RUN_MODE_OPTIONS,
  SOURCE_CONTINUE_OPTIONS,
} from "./constants.js";
import type {
  CompleteSetupOptions,
  InitSetupProps,
  LangsmithWorkspaceDraft,
  PromptInputKey,
  PromptStep,
  ReasoningEffortSelection,
  SourceSetupOption,
  SourceSetupState,
} from "./types.js";
import { buildCredentialEnvUpdates } from "./persistence.js";
import type { InitSetupViewProps } from "./view.js";

/**
 * The controller behind `InitSetup`: it owns the entire setup state machine
 * (state, refs, effects, keyboard routing, and completion/persistence) and
 * returns the fully-wired presentational props for `InitSetupView`. Splitting it
 * out keeps `credentials.tsx` a thin composition root and isolates the
 * hard-to-unit-test Ink keyboard flow in one file (excluded from coverage).
 */
export function useInitSetup({
  allowModeSelection = false,
  mode,
  modelIdOverride = null,
  onComplete,
  onError,
  walkAllSteps = false,
}: InitSetupProps): InitSetupViewProps {
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
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffortSelection | null>(null);
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
  const [reasoningEffortSelectionIndex, setReasoningEffortSelectionIndex] =
    useState(0);
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
      case "reasoning-effort": {
        const selectedModelId =
          modelId ??
          modelIdOverride ??
          getSavedEnvValue(OPENWIKI_MODEL_ID_ENV_KEY) ??
          getDefaultModelId(provider);
        const selectedEffort =
          reasoningEffort ??
          getSavedEnvValue(OPENWIKI_REASONING_EFFORT_ENV_KEY) ??
          "";
        setReasoningEffortSelectionIndex(
          getReasoningEffortSelectionIndex(
            provider,
            selectedModelId,
            selectedEffort,
          ),
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

    if (step === "reasoning-effort") {
      const selectedModelId =
        modelId ?? modelIdOverride ?? getDefaultModelId(provider);
      const optionCount = getReasoningEffortSelectionOptions(
        provider,
        selectedModelId,
      ).length;
      handleMenuInput(key, () =>
        setReasoningEffortSelectionIndex((index) =>
          moveSelectionIndex(index, key.upArrow ? -1 : 1, optionCount),
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
        setReasoningEffort(null);
        setReasoningEffortSelectionIndex(0);
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

      const reasoningEffortOptions = getReasoningEffortSelectionOptions(
        provider,
        selectedModelId,
      );
      if (reasoningEffortOptions.length > 0) {
        const selectedEffort =
          reasoningEffort ??
          getSavedEnvValue(OPENWIKI_REASONING_EFFORT_ENV_KEY) ??
          "";
        setReasoningEffortSelectionIndex(
          getReasoningEffortSelectionIndex(
            provider,
            selectedModelId,
            selectedEffort,
          ),
        );
        setStep("reasoning-effort");
        return;
      }

      // One setting is shared across providers/models. Clear a previous choice
      // when the newly selected model has no compatible reasoning-effort API.
      setReasoningEffort("");
      await continueAfterModel(selectedModelId, "");
      return;
    }

    if (step === "reasoning-effort") {
      const selectedModelId =
        modelId ?? modelIdOverride ?? getDefaultModelId(provider);
      const selectedEffort =
        getReasoningEffortSelectionOptions(provider, selectedModelId)[
          reasoningEffortSelectionIndex
        ]?.value ?? "";

      setReasoningEffort(selectedEffort);
      await continueAfterModel(selectedModelId, selectedEffort);
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
        nextReasoningEffort: reasoningEffort,
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

  async function continueAfterModel(
    nextModelId: string,
    nextReasoningEffort: ReasoningEffortSelection,
  ): Promise<void> {
    // LangSmith is the next spine step, but it is optional: once the user has
    // recorded a tracing decision (LANGCHAIN_TRACING_V2 set, or a key present)
    // do not re-prompt on a later setup pass. An explicit --init re-walk
    // (walkAllSteps) still visits it so the whole setup can be reconfigured.
    if (walkAllSteps || needsLangSmithStep()) {
      seedInputForStep("langsmith");
      setStep("langsmith");
      return;
    }

    await continueAfterCredentials({
      nextApiKey: apiKey,
      nextBaseUrl: baseUrl,
      nextSecretKey: secretKey,
      nextRegion: region,
      nextGcpLocation: gcpLocation,
      nextGcpProject: gcpProject,
      nextLangSmithKey: langSmithKey,
      nextModelId,
      nextReasoningEffort,
      nextOAuthTokens: oauthTokens,
      nextProvider: provider,
      runMode: selectedMode,
    });
  }

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

  async function saveCredentialUpdates(options: CompleteSetupOptions) {
    setIsSaving(true);

    try {
      const updates = buildCredentialEnvUpdates(
        {
          ...options,
          // Preserve the original default-param semantics: an omitted
          // (undefined) field falls back to the current oauth tokens, but an
          // explicit null stays null.
          nextOAuthTokens:
            options.nextOAuthTokens === undefined
              ? oauthTokens
              : options.nextOAuthTokens,
        },
        process.env,
      );

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

  return {
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
    reasoningEffort,
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
    reasoningEffortSelectionIndex,
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
    navHistoryLength: navHistory.current.length,
  };
}
