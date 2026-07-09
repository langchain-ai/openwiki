import React, { useEffect, useMemo, useState } from "react";
import { homedir } from "node:os";
import path from "node:path";
import { Box, Text, useInput, useStdout } from "ink";
import { configureAuthProvider } from "./auth/configure.js";
import { runOAuthAuth } from "./auth/oauth.js";
import {
  DEFAULT_PROVIDER,
  getDefaultModelId,
  getProviderApiKeyEnvKey,
  getProviderBaseUrlEnvKey,
  getProviderLabel,
  getProviderModelOptions,
  isValidBaseUrl,
  isValidModelId,
  normalizeProvider,
  normalizeModelId,
  OPENWIKI_GOOGLE_CLIENT_ID_ENV_KEY,
  OPENWIKI_GOOGLE_CLIENT_SECRET_ENV_KEY,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
  OPENWIKI_TAVILY_API_KEY_ENV_KEY,
  OPENWIKI_X_CLIENT_ID_ENV_KEY,
  type OpenWikiProvider,
  providerRequiresBaseUrl,
  resolveConfiguredProvider,
  SELECTABLE_OPENWIKI_PROVIDERS,
} from "./constants.js";
import type { AuthProviderId } from "./auth/types.js";
import type { OpenWikiRunMode } from "./commands.js";
import type { ConnectorId } from "./connectors/types.js";
import { getConnectorConfigPath } from "./openwiki-home.js";
import { openWikiEnvPath, saveOpenWikiEnv } from "./env.js";
import {
  createEmptyOnboardingConfig,
  isOpenWikiOnboardingCompleteSync,
  isOnboardingComplete,
  openWikiOnboardingPath,
  readOpenWikiOnboardingConfig,
  saveOpenWikiOnboardingConfig,
  type OpenWikiOnboardingConfig,
} from "./onboarding.js";
import {
  getSuggestedCronExpression,
  installOpenWikiPowerSchedule,
  installConnectorSchedule,
  validateCronExpression,
} from "./schedules.js";

export type InitSetupResult = {
  mode: OpenWikiRunMode;
  modelId: string | null;
  onboardingCompleted: boolean;
  provider: OpenWikiProvider | null;
  runIngestionNow: boolean;
  savedApiKey: boolean;
  savedBaseUrl: boolean;
  savedLangSmithKey: boolean;
  savedModelId: boolean;
  savedProvider: boolean;
  shouldContinueToRun: boolean;
};

type InitSetupProps = {
  allowModeSelection?: boolean;
  mode: OpenWikiRunMode;
  modelIdOverride?: string | null;
  onComplete: (result: InitSetupResult) => void;
  onError: (message: string) => void;
};

type PromptStep =
  | "api-key"
  | "base-url"
  | "final"
  | "langsmith"
  | "model"
  | "provider"
  | "run-mode"
  | "source-auth"
  | "global-cron-custom"
  | "global-cron-mode"
  | "global-power-mode"
  | "source-description"
  | "source-description-custom"
  | "source-menu"
  | "source-path"
  | "source-confirm-continue"
  | "source-secret"
  | "template"
  | "wiki-goal";

type SourceSetupOption = {
  authProvider?: AuthProviderId;
  displayName: string;
  examples: string[];
  id: ConnectorId;
  instructions: string[];
  secretInputs: SourceSecretInput[];
};

type SourceSecretInput = {
  envKey: string;
  label: string;
  optional?: boolean;
  secret?: boolean;
};

type SourceSetupState = {
  authUrl?: string;
  connectorConfig?: Record<string, unknown>;
  copiedAuthUrlToClipboard?: boolean;
  savedScheduleWarning?: string;
  secretValues: Record<string, string>;
};

type PromptInputKey = {
  backspace?: boolean;
  ctrl?: boolean;
  delete?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  meta?: boolean;
  return?: boolean;
  rightArrow?: boolean;
  tab?: boolean;
  upArrow?: boolean;
};

type ModelSelectionOption =
  | {
      id: string;
      kind: "preset";
      label: string;
    }
  | {
      kind: "custom";
    };

type OnboardingMode = {
  description: string;
  id: string;
  name: string;
  sourceIds: ConnectorId[];
  suggestedSources: string[];
  suggestedGoal: string;
};

const ONBOARDING_TEMPLATES = [
  {
    description:
      "Maintain a structured project wiki from a local Git repository, with code-oriented pages for architecture, workflows, source maps, and operational guidance.",
    id: "code",
    name: "Code",
    sourceIds: ["git-repo"],
    suggestedSources: ["Local Git repository"],
    suggestedGoal:
      "A code wiki for this local repository. Prioritize a concise quickstart, architecture overview, source map, key workflows, domain concepts, operations/runbook notes, testing guidance, and integration points. Keep pages grounded in the repository structure and recent code changes. Prefer practical navigation for engineers over generic summaries.",
  },
  {
    description:
      "A personal assistant wiki that builds memory from email, notes, social/research sources, and web search so you can ask about projects, priorities, people, and recurring context.",
    id: "personal",
    name: "Personal",
    sourceIds: [
      "git-repo",
      "google",
      "notion",
      "web-search",
      "hackernews",
      "x",
    ],
    suggestedSources: [
      "Gmail",
      "Notion",
      "Web Search (Tavily)",
      "Hacker News",
      "X/Twitter",
    ],
    suggestedGoal:
      "Your personal brain. Track active projects, people, organizations, decisions, commitments, follow-ups, useful links, recurring themes, and fresh external signals. Organize the wiki so a personal assistant can answer what changed, what matters, what needs attention, and where supporting evidence came from. Be selective: summarize durable context and explicit action items, not every raw item.",
  },
] as const satisfies readonly OnboardingMode[];

const RUN_MODE_OPTIONS = [
  {
    description:
      "Build a local personal brain wiki in ~/.openwiki/wiki from configured sources.",
    id: "personal",
    name: "Personal",
  },
  {
    description:
      "Build repository documentation in ./openwiki for this codebase.",
    id: "code",
    name: "Code",
  },
] as const satisfies readonly {
  description: string;
  id: OpenWikiRunMode;
  name: string;
}[];

const SOURCE_OPTIONS = [
  {
    displayName: "Local Git repository",
    examples: [
      "Track architecture notes from this repo.",
      "Summarize recent commits and changed files.",
    ],
    id: "git-repo",
    instructions: [
      "Choose the local repository directory OpenWiki should read.",
      "The default is the current working directory, and you can replace it with another path.",
      "You can add more repositories later in the connector config file.",
    ],
    secretInputs: [],
  },
  {
    authProvider: "notion",
    displayName: "Notion",
    examples: [
      "Ingest product specs, meeting notes, and research pages.",
      "Prioritize pages related to Applied AI and customer feedback.",
    ],
    id: "notion",
    instructions: [
      "OpenWiki uses Notion's hosted MCP OAuth flow.",
      "No client ID, client secret, or pasted Notion token is required.",
      "Approve access in the browser window when it opens.",
    ],
    secretInputs: [],
  },
  {
    authProvider: "gmail",
    displayName: "Gmail",
    examples: [
      "Capture important project email threads from the last 24 hours.",
      "Look for vendor updates, customer feedback, and action items.",
    ],
    id: "google",
    instructions: [
      "Create OAuth credentials in Google Cloud for a desktop or web app.",
      "Enable the Gmail API for the Google Cloud project.",
      "Add http://127.0.0.1:53682/callback as an authorized redirect URI.",
      "Paste the client ID and client secret below.",
    ],
    secretInputs: [
      {
        envKey: OPENWIKI_GOOGLE_CLIENT_ID_ENV_KEY,
        label: "Google OAuth client ID",
      },
      {
        envKey: OPENWIKI_GOOGLE_CLIENT_SECRET_ENV_KEY,
        label: "Google OAuth client secret",
        secret: true,
      },
    ],
  },
  {
    displayName: "Web Search (Tavily)",
    examples: [
      "Track a company, product category, or technical topic.",
      "Find launch posts, docs, pricing pages, and recent articles.",
    ],
    id: "web-search",
    instructions: [
      "Create a Tavily account and API key.",
      "Paste the Tavily API key below.",
      "Describe the topics, companies, or pages OpenWiki should search for on the next screen.",
    ],
    secretInputs: [
      {
        envKey: OPENWIKI_TAVILY_API_KEY_ENV_KEY,
        label: "Tavily API key",
        secret: true,
      },
    ],
  },
  {
    displayName: "Hacker News",
    examples: [
      "Monitor threads about AI agents, evals, infrastructure, and startups.",
      "Capture notable discussions and links related to my research topics.",
    ],
    id: "hackernews",
    instructions: [
      "No account setup is required for Hacker News.",
      "OpenWiki uses public Hacker News feed and search APIs.",
      "Describe the topics, keywords, users, or story types OpenWiki should watch on the next screen.",
    ],
    secretInputs: [],
  },
  {
    authProvider: "x",
    displayName: "X / Twitter",
    examples: [
      "Track my home timeline, bookmarks, and key lists.",
      "Summarize tweets from AI researchers and product announcements.",
    ],
    id: "x",
    instructions: [
      "Create an X OAuth 2.0 app.",
      "Use a native app or public client when possible.",
      "Add http://127.0.0.1:53682/callback as a callback URI.",
      "Paste the OAuth client ID below.",
    ],
    secretInputs: [
      {
        envKey: OPENWIKI_X_CLIENT_ID_ENV_KEY,
        label: "X OAuth client ID",
      },
    ],
  },
] as const satisfies readonly SourceSetupOption[];

const CRON_MODE_OPTIONS = [
  "Use suggested schedule",
  "Enter custom cron",
] as const;
const POWER_MODE_OPTIONS = [
  "Set up Mac wake/sleep window",
  "Skip power setup",
] as const;
const CRON_FIELD_LABELS = ["minute", "hour", "day", "month", "weekday"];
const SOURCE_CONTINUE_OPTIONS = [
  "Go back to connections",
  "Continue without all sources",
] as const;
const FINAL_OPTIONS = [
  "Run ingestion now",
  "Wait until scheduled time",
] as const;

export function needsCredentialSetup(
  modelIdOverride: string | null = null,
  mode: OpenWikiRunMode = "personal",
): boolean {
  const provider = resolveConfiguredProvider();
  const apiKeyEnvKey = getProviderApiKeyEnvKey(provider);

  const needsCredentials =
    !hasValidConfiguredProvider() ||
    !process.env[apiKeyEnvKey] ||
    needsBaseUrlStep(provider) ||
    (modelIdOverride === null &&
      process.env[OPENWIKI_MODEL_ID_ENV_KEY] === undefined) ||
    process.env.LANGSMITH_API_KEY === undefined;

  return (
    needsCredentials ||
    (mode === "personal" && !isOpenWikiOnboardingCompleteSync())
  );
}

function needsBaseUrlStep(provider: OpenWikiProvider): boolean {
  if (!providerRequiresBaseUrl(provider)) {
    return false;
  }

  return !isBaseUrlConfigured(provider);
}

function isBaseUrlConfigured(provider: OpenWikiProvider): boolean {
  const baseUrlEnvKey = getProviderBaseUrlEnvKey(provider);

  return baseUrlEnvKey ? Boolean(process.env[baseUrlEnvKey]) : false;
}

export function InitSetup({
  allowModeSelection = false,
  mode,
  modelIdOverride = null,
  onComplete,
  onError,
}: InitSetupProps) {
  const { stdout } = useStdout();
  const initialProvider = resolveConfiguredProvider();
  const [step, setStep] = useState<PromptStep | null>(null);
  const [selectedMode, setSelectedMode] = useState<OpenWikiRunMode>(mode);
  const [provider, setProvider] = useState<OpenWikiProvider>(initialProvider);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [langSmithKey, setLangSmithKey] = useState<string | null>(null);
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
  const [isCustomModelInput, setIsCustomModelInput] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isAuthRunning, setIsAuthRunning] = useState(false);

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
        if (cancelled) {
          return;
        }

        const configForMode = allowModeSelection
          ? config
          : ensureRunModeConfig(config, mode);
        if (configForMode !== config) {
          await saveOpenWikiOnboardingConfig(configForMode);
        }
        setOnboardingConfig(configForMode);
        const initialStep = getInitialStep(
          modelIdOverride,
          initialProvider,
          configForMode,
          mode,
          allowModeSelection,
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
            savedLangSmithKey: false,
            savedModelId: false,
            savedProvider: false,
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

  useInput((inputValue, key) => {
    if (isSaving || isAuthRunning || step === null) {
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
        setStep(nextStep);
        return;
      }

      await completeSetup({
        nextApiKey: apiKey,
        nextBaseUrl: baseUrl,
        nextLangSmithKey: langSmithKey,
        nextModelId: modelId,
        nextProvider: provider,
        runMode: selectedOption.id,
      });
      return;
    }

    if (step === "provider") {
      const selectedProvider =
        SELECTABLE_OPENWIKI_PROVIDERS[providerSelectionIndex] ??
        DEFAULT_PROVIDER;

      setProvider(selectedProvider);
      setProviderSelectionIndex(getProviderSelectionIndex(selectedProvider));
      setModelSelectionIndex(
        getModelSelectionIndex(
          selectedProvider,
          getDefaultModelId(selectedProvider),
        ),
      );
      setInput("");
      const nextStep = getNextStepAfterProvider(
        selectedProvider,
        modelIdOverride,
        onboardingConfig,
        selectedMode,
      );

      if (nextStep) {
        setIsCustomModelInput(
          nextStep === "model" &&
            shouldStartWithCustomModelInput(selectedProvider),
        );
        setStep(nextStep);
        return;
      }

      await completeSetup({
        nextApiKey: apiKey,
        nextBaseUrl: baseUrl,
        nextLangSmithKey: langSmithKey,
        nextModelId: modelId,
        nextProvider: selectedProvider,
        runMode: selectedMode,
      });
      return;
    }

    if (step === "api-key") {
      const trimmedInput = input.trim();

      if (trimmedInput.length === 0) {
        setError(`${getProviderApiKeyEnvKey(provider)} is required.`);
        return;
      }

      setApiKey(trimmedInput);
      setInput("");
      const nextStep = getNextStepAfterApiKey(
        provider,
        modelIdOverride,
        onboardingConfig,
        selectedMode,
      );

      if (nextStep) {
        setIsCustomModelInput(
          nextStep === "model" && shouldStartWithCustomModelInput(provider),
        );
        setStep(nextStep);
        return;
      }

      await completeSetup({
        nextApiKey: trimmedInput,
        nextBaseUrl: baseUrl,
        nextLangSmithKey: langSmithKey,
        nextModelId: modelId,
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

      if (!isValidBaseUrl(trimmedInput)) {
        setError("Enter a valid http(s) base URL.");
        return;
      }

      setBaseUrl(trimmedInput);
      setInput("");
      const nextStep = getNextStepAfterBaseUrl(
        provider,
        modelIdOverride,
        onboardingConfig,
        selectedMode,
      );

      if (nextStep) {
        setIsCustomModelInput(
          nextStep === "model" && shouldStartWithCustomModelInput(provider),
        );
        setStep(nextStep);
        return;
      }

      await completeSetup({
        nextApiKey: apiKey,
        nextBaseUrl: trimmedInput,
        nextLangSmithKey: langSmithKey,
        nextModelId: modelId,
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

      if (process.env.LANGSMITH_API_KEY === undefined) {
        setStep("langsmith");
        return;
      }

      await continueAfterCredentials({
        nextApiKey: apiKey,
        nextBaseUrl: baseUrl,
        nextLangSmithKey: langSmithKey,
        nextModelId: selectedModelId,
        nextProvider: provider,
        runMode: selectedMode,
      });
      return;
    }

    if (step === "langsmith") {
      const nextLangSmithKey = input.trim();

      setLangSmithKey(nextLangSmithKey);
      setInput("");

      await continueAfterCredentials({
        nextApiKey: apiKey,
        nextBaseUrl: baseUrl,
        nextLangSmithKey,
        nextModelId: modelId,
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
      await saveConfig(nextConfig);
      setInput("");
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
      setInput(selectedTemplate.suggestedGoal);
      setStep("wiki-goal");
      return;
    }

    if (step === "source-menu") {
      if (sourceSelectionIndex >= activeSourceOptions.length) {
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
      const runIngestionNow =
        FINAL_OPTIONS[finalSelectionIndex] === "Run ingestion now";
      const nextConfig = {
        ...onboardingConfig,
        completedAt: new Date().toISOString(),
      };
      await saveConfig(nextConfig);
      onComplete({
        mode: selectedMode,
        modelId:
          modelId ??
          modelIdOverride ??
          process.env[OPENWIKI_MODEL_ID_ENV_KEY] ??
          null,
        onboardingCompleted: true,
        provider,
        runIngestionNow,
        savedApiKey: apiKey !== null,
        savedBaseUrl: baseUrl !== null,
        savedLangSmithKey: langSmithKey !== null && langSmithKey.length > 0,
        savedModelId: modelId !== null,
        savedProvider: process.env[OPENWIKI_PROVIDER_ENV_KEY] !== provider,
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
    nextLangSmithKey: string | null;
    nextModelId: string | null;
    nextProvider: OpenWikiProvider;
    runMode: OpenWikiRunMode;
  };

  async function continueAfterCredentials(options: CompleteSetupOptions) {
    await saveCredentialUpdates(options);

    if (options.runMode === "code") {
      await completeSetup(options);
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
      mode: options.runMode,
      runIngestionNow: false,
      savedApiKey: options.nextApiKey !== null,
      savedBaseUrl: options.nextBaseUrl !== null,
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
    nextLangSmithKey,
    nextModelId,
    nextProvider,
  }: CompleteSetupOptions) {
    setIsSaving(true);

    try {
      const updates: Record<string, string> = {};

      if (process.env[OPENWIKI_PROVIDER_ENV_KEY] !== nextProvider) {
        updates[OPENWIKI_PROVIDER_ENV_KEY] = nextProvider;
      }

      if (nextApiKey !== null) {
        updates[getProviderApiKeyEnvKey(nextProvider)] = nextApiKey;
      }

      if (nextBaseUrl !== null) {
        const baseUrlEnvKey = getProviderBaseUrlEnvKey(nextProvider);

        if (baseUrlEnvKey) {
          updates[baseUrlEnvKey] = nextBaseUrl;
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

  function returnToSourceMenu() {
    setSourceSelectionIndex(activeSourceOptions.length);
    setSourceState({ secretValues: {} });
    setInput("");
    setStep("source-menu");
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

  const needsCredentialPrompt =
    !hasValidConfiguredProvider() ||
    !process.env[getProviderApiKeyEnvKey(provider)] ||
    needsBaseUrlStep(provider) ||
    (modelIdOverride === null &&
      process.env[OPENWIKI_MODEL_ID_ENV_KEY] === undefined) ||
    process.env.LANGSMITH_API_KEY === undefined;

  return (
    <Box flexDirection="column">
      <SetupHeader />

      <Box flexDirection="column" marginBottom={1}>
        <SetupStep
          label="Provider"
          state={
            hasValidConfiguredProvider()
              ? "done"
              : step === "provider"
                ? "current"
                : "pending"
          }
          detail={getProviderSetupDetail(provider)}
        />
        <SetupStep
          label="Provider key"
          state={
            process.env[getProviderApiKeyEnvKey(provider)]
              ? "done"
              : step === "api-key"
                ? "current"
                : "pending"
          }
          detail={
            process.env[getProviderApiKeyEnvKey(provider)]
              ? "available from environment"
              : `save ${getProviderApiKeyEnvKey(provider)} to ${openWikiEnvPath}`
          }
        />
        {providerRequiresBaseUrl(provider) ? (
          <SetupStep
            label="Base URL"
            state={
              isBaseUrlConfigured(provider)
                ? "done"
                : step === "base-url"
                  ? "current"
                  : "pending"
            }
            detail={
              isBaseUrlConfigured(provider)
                ? "available from environment"
                : `save ${getProviderBaseUrlEnvKey(provider)} to ${openWikiEnvPath}`
            }
          />
        ) : null}
        <SetupStep
          label="Model"
          state={
            modelIdOverride || process.env[OPENWIKI_MODEL_ID_ENV_KEY]
              ? "done"
              : step === "model"
                ? "current"
                : "pending"
          }
          detail={getModelSetupDetail(modelIdOverride, provider)}
        />
        <SetupStep
          label="LangSmith"
          state={
            process.env.LANGSMITH_API_KEY !== undefined
              ? "done"
              : step === "langsmith"
                ? "current"
                : "optional"
          }
          detail={
            process.env.LANGSMITH_API_KEY !== undefined
              ? "available from environment"
              : "optional tracing key"
          }
        />
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
        {selectedMode === "personal" ? (
          <SetupStep
            label="Personal profile"
            state={
              onboardingConfig.templateId
                ? "done"
                : step === "template"
                  ? "current"
                  : "pending"
            }
            detail={getConfigModeName(onboardingConfig) ?? "choose a profile"}
          />
        ) : null}
        <SetupStep
          label="Wiki scope"
          state={
            selectedMode === "code"
              ? "done"
              : onboardingConfig.wikiGoal
                ? "done"
                : step === "wiki-goal"
                  ? "current"
                  : "pending"
          }
          detail={
            selectedMode === "code"
              ? "repository openwiki/"
              : onboardingConfig.wikiGoal
                ? "saved"
                : `save onboarding profile to ${openWikiOnboardingPath}`
          }
        />
        {selectedMode === "personal" ? (
          <SetupStep
            label="Schedule"
            state={
              onboardingConfig.ingestionSchedule
                ? "done"
                : isScheduleStep(step)
                  ? "current"
                  : "pending"
            }
            detail={
              onboardingConfig.ingestionSchedule
                ? onboardingConfig.ingestionSchedule.description
                : "choose one time for all ingestion"
            }
          />
        ) : null}
        {selectedMode === "personal" ? (
          <SetupStep
            label="Sources"
            state={
              getConnectedSourceCount(onboardingConfig, activeSourceOptions) > 0
                ? "done"
                : isSourceStep(step)
                  ? "current"
                  : "pending"
            }
            detail={`${getConnectedSourceCount(
              onboardingConfig,
              activeSourceOptions,
            )} setup(s) configured`}
          />
        ) : null}
      </Box>

      <SetupPanel title="Prompt">
        {step ? (
          <Prompt
            cronFieldSelectionIndex={cronFieldSelectionIndex}
            cronModeSelectionIndex={cronModeSelectionIndex}
            finalSelectionIndex={finalSelectionIndex}
            input={input}
            inputDisplayWidth={inputDisplayWidth}
            isCustomModelInput={isCustomModelInput}
            modelSelectionIndex={modelSelectionIndex}
            onboardingConfig={onboardingConfig}
            powerModeSelectionIndex={powerModeSelectionIndex}
            provider={provider}
            providerSelectionIndex={providerSelectionIndex}
            runModeSelectionIndex={runModeSelectionIndex}
            secretInputIndex={secretInputIndex}
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

      {needsCredentialPrompt ? (
        <Text color="gray">Secrets are masked and saved only after setup.</Text>
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
  cronFieldSelectionIndex,
  cronModeSelectionIndex,
  finalSelectionIndex,
  input,
  inputDisplayWidth,
  isCustomModelInput,
  modelSelectionIndex,
  onboardingConfig,
  powerModeSelectionIndex,
  provider,
  providerSelectionIndex,
  runModeSelectionIndex,
  secretInputIndex,
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
  cronFieldSelectionIndex: number;
  cronModeSelectionIndex: number;
  finalSelectionIndex: number;
  input: string;
  inputDisplayWidth: number;
  isCustomModelInput: boolean;
  modelSelectionIndex: number;
  onboardingConfig: OpenWikiOnboardingConfig;
  powerModeSelectionIndex: number;
  provider: OpenWikiProvider;
  providerSelectionIndex: number;
  runModeSelectionIndex: number;
  secretInputIndex: number;
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
        <Text>Paste your {getProviderLabel(provider)} API key.</Text>
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

  if (step === "source-menu") {
    const configuredCount = getConnectedSourceCount(
      onboardingConfig,
      sourceOptions,
    );

    return (
      <Box flexDirection="column">
        <Text>Configure sources for this mode.</Text>
        {sourceOptions.map((source, index) => {
          const sourceInstances = getSourceInstances(
            onboardingConfig,
            source.id,
          );
          return (
            <Box flexDirection="column" key={source.id}>
              <Text>
                <SelectionMarker isSelected={index === sourceSelectionIndex} />{" "}
                {getSourceMenuLabel(source, sourceInstances.length)}{" "}
                <SourceConnectionStatus
                  count={sourceInstances.length}
                  isConfigured={sourceInstances.length > 0}
                />
              </Text>
              {sourceInstances.map((sourceInstance) => (
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
        {FINAL_OPTIONS.map((option, index) => (
          <Text key={option}>
            <SelectionMarker isSelected={index === finalSelectionIndex} />{" "}
            {option}
          </Text>
        ))}
        <Text color="gray">
          Run now executes one source-specific ingestion and wiki update per
          configured source. Waiting exits and lets the saved schedules run.
        </Text>
      </Box>
    );
  }

  return null;
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
      <Text>Configure the model, wiki scope, sources, and schedules.</Text>
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
  state: "current" | "done" | "optional" | "pending";
}) {
  const color =
    state === "done"
      ? "green"
      : state === "current"
        ? "yellow"
        : state === "optional"
          ? "cyan"
          : "gray";

  return (
    <Text>
      <Text color={color}>[{state.toUpperCase()}]</Text>{" "}
      <Text bold>{label.padEnd(16)}</Text> <Text color="gray">{detail}</Text>
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
  copiedToClipboard,
  url,
}: {
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
        {copiedToClipboard
          ? "Full URL copied to clipboard. It is also shown below."
          : "Copy the full raw URL below if the link is not clickable."}
      </Text>
      <Text color="gray" wrap="wrap">
        {url}
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

function formatSecretInputDisplay(value: string): string {
  return value.length === 0 ? "empty" : `hidden (${value.length} chars)`;
}

function formatTerminalHyperlink(url: string, label: string): string {
  return `\u001B]8;;${url}\u0007${label}\u001B]8;;\u0007`;
}

function getSingleLineInputDisplayValue(
  value: string,
  maxLength: number,
): string {
  if (maxLength <= 0) {
    return "";
  }

  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 3) {
    return value.slice(-maxLength);
  }

  return `...${value.slice(-(maxLength - 3))}`;
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

function getInitialStep(
  modelIdOverride: string | null,
  provider: OpenWikiProvider,
  onboardingConfig: OpenWikiOnboardingConfig,
  mode: OpenWikiRunMode,
  allowModeSelection: boolean,
): PromptStep | null {
  if (allowModeSelection) {
    return "run-mode";
  }

  if (!hasValidConfiguredProvider()) {
    return "provider";
  }

  if (!process.env[getProviderApiKeyEnvKey(provider)]) {
    return "api-key";
  }

  if (needsBaseUrlStep(provider)) {
    return "base-url";
  }

  if (
    modelIdOverride === null &&
    process.env[OPENWIKI_MODEL_ID_ENV_KEY] === undefined
  ) {
    return "model";
  }

  if (process.env.LANGSMITH_API_KEY === undefined) {
    return "langsmith";
  }

  if (mode === "code") {
    return null;
  }

  if (!getConfigModeId(onboardingConfig)) {
    return "template";
  }

  if (!onboardingConfig.wikiGoal) {
    return "wiki-goal";
  }

  if (!onboardingConfig.ingestionSchedule) {
    return "global-cron-mode";
  }

  if (!isOnboardingComplete(onboardingConfig)) {
    return "source-menu";
  }

  return null;
}

function getNextStepAfterProvider(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
  onboardingConfig: OpenWikiOnboardingConfig,
  mode: OpenWikiRunMode,
): PromptStep | null {
  if (!process.env[getProviderApiKeyEnvKey(provider)]) {
    return "api-key";
  }

  return getNextStepAfterApiKey(
    provider,
    modelIdOverride,
    onboardingConfig,
    mode,
  );
}

function getNextStepAfterApiKey(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
  onboardingConfig: OpenWikiOnboardingConfig,
  mode: OpenWikiRunMode,
): PromptStep | null {
  if (needsBaseUrlStep(provider)) {
    return "base-url";
  }

  return getNextStepAfterBaseUrl(
    provider,
    modelIdOverride,
    onboardingConfig,
    mode,
  );
}

function getNextStepAfterBaseUrl(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
  onboardingConfig: OpenWikiOnboardingConfig,
  mode: OpenWikiRunMode,
): PromptStep | null {
  if (
    modelIdOverride === null &&
    process.env[OPENWIKI_MODEL_ID_ENV_KEY] === undefined
  ) {
    return "model";
  }

  if (process.env.LANGSMITH_API_KEY === undefined) {
    return "langsmith";
  }

  if (mode === "code") {
    return null;
  }

  if (!getConfigModeId(onboardingConfig)) {
    return "template";
  }

  if (!onboardingConfig.wikiGoal) {
    return "wiki-goal";
  }

  if (!onboardingConfig.ingestionSchedule) {
    return "global-cron-mode";
  }

  if (!isOnboardingComplete(onboardingConfig)) {
    return "source-menu";
  }

  return null;
}

function ensureRunModeConfig(
  config: OpenWikiOnboardingConfig,
  mode: OpenWikiRunMode,
): OpenWikiOnboardingConfig {
  if (mode !== "personal" || getConfigModeId(config) === "personal") {
    return config;
  }

  const personalMode = ONBOARDING_TEMPLATES.find(
    (option) => option.id === "personal",
  );
  if (!personalMode) {
    return config;
  }

  return {
    ...config,
    modeId: personalMode.id,
    modeName: personalMode.name,
    templateId: personalMode.id,
    templateName: personalMode.name,
  };
}

function getRunModeSelectionIndex(mode: OpenWikiRunMode): number {
  const index = RUN_MODE_OPTIONS.findIndex((option) => option.id === mode);
  return index === -1 ? 0 : index;
}

function getRunModeName(mode: OpenWikiRunMode): string {
  return RUN_MODE_OPTIONS.find((option) => option.id === mode)?.name ?? mode;
}

function getSourceOption(sourceId: ConnectorId): SourceSetupOption {
  return (
    SOURCE_OPTIONS.find((source) => source.id === sourceId) ?? SOURCE_OPTIONS[0]
  );
}

function getConfigModeId(config: OpenWikiOnboardingConfig): string | undefined {
  return config.modeId ?? config.templateId;
}

function getConfigModeName(
  config: OpenWikiOnboardingConfig,
): string | undefined {
  return config.modeName ?? config.templateName;
}

function isCodeMode(config: OpenWikiOnboardingConfig): boolean {
  return getConfigModeId(config) === "code";
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

function getProviderSetupDetail(provider: OpenWikiProvider): string {
  if (hasValidConfiguredProvider()) {
    return getProviderLabel(provider);
  }

  return `default ${getProviderLabel(DEFAULT_PROVIDER)}`;
}

function hasValidConfiguredProvider(): boolean {
  return normalizeProvider(process.env[OPENWIKI_PROVIDER_ENV_KEY]) !== null;
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
  return provider === "baseten" || provider === "fireworks" ? "a" : "an";
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
