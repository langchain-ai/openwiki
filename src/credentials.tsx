import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { homedir } from "node:os";
import path from "node:path";
import { Box, Text, useInput, useStdout } from "ink";
import { configureAuthProvider } from "./auth/configure.js";
import { runOAuthAuth } from "./auth/oauth.js";
import {
  DEFAULT_PROVIDER,
  DEFAULT_VERTEX_LOCATION,
  getDefaultModelId,
  getMissingProviderEnvKey,
  getProviderApiKeyEnvKey,
  getProviderBaseUrlEnvKey,
  getProviderLabel,
  getProviderLocationEnvKey,
  getProviderModelOptions,
  getProviderProjectEnvKey,
  getProviderRegionEnvKey,
  getProviderSecretKeyEnvKey,
  providerRequiresApiKey,
  isValidBaseUrl,
  isValidModelId,
  normalizeProvider,
  normalizeModelId,
  OPENAI_CHATGPT_EMAIL_ENV_KEY,
  OPENAI_CHATGPT_PLAN_ENV_KEY,
  OPENWIKI_GOOGLE_CLIENT_ID_ENV_KEY,
  OPENWIKI_GOOGLE_CLIENT_SECRET_ENV_KEY,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
  OPENWIKI_TAVILY_API_KEY_ENV_KEY,
  OPENWIKI_X_CLIENT_ID_ENV_KEY,
  type OpenWikiProvider,
  providerRequiresBaseUrl,
  providerRequiresRegion,
  providerRequiresSecretKey,
  providerUsesOAuth,
  resolveConfiguredProvider,
  SELECTABLE_OPENWIKI_PROVIDERS,
} from "./constants.js";
import {
  type ChatGptLoginHandle,
  type CodexTokens,
  codexTokensToEnv,
  formatChatGptAccount,
  isChatGptTokenExpired,
  loginWithChatGPT,
  readCodexTokensFromEnv,
} from "./agent/openai-chatgpt-oauth.js";
import type { AuthProviderId } from "./auth/types.js";
import type { OpenWikiRunMode } from "./commands.js";
import type { ConnectorId } from "./connectors/types.js";
import { getConnectorConfigPath } from "./openwiki-home.js";
import {
  getSavedEnvValue,
  getShellEnvValue,
  openWikiEnvPath,
  saveOpenWikiEnv,
} from "./env.js";
import {
  createEmptyOnboardingConfig,
  isOpenWikiOnboardingCompleteSync,
  isOnboardingComplete,
  isRepositoryCodeOnboardingCompleteSync,
  readOpenWikiOnboardingConfig,
  readRepositoryWikiInstructions,
  saveRepositoryWikiInstructions,
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
  repoRoot?: string;
  runIngestionNow: boolean;
  savedApiKey: boolean;
  savedBaseUrl: boolean;
  savedGcpLocation: boolean;
  savedGcpProject: boolean;
  savedLangSmithKey: boolean;
  savedModelId: boolean;
  savedProvider: boolean;
  savedRegion: boolean;
  savedSecretKey: boolean;
  shouldContinueToRun: boolean;
};

type InitSetupProps = {
  allowModeSelection?: boolean;
  mode: OpenWikiRunMode;
  modelIdOverride?: string | null;
  onComplete: (result: InitSetupResult) => void;
  onError: (message: string) => void;
  /**
   * When true (explicit `--init`), walk every applicable step even when it is
   * already configured, so the run can review/change any of them. When false
   * the wizard skips satisfied steps and collects only what is missing.
   */
  walkAllSteps?: boolean;
};

type PromptStep =
  | "api-key"
  | "base-url"
  | "code-repo-confirm"
  | "code-repo-path"
  | "final"
  | "gcp-location"
  | "gcp-project"
  | "langsmith"
  | "model"
  | "oauth-login"
  | "provider"
  | "region"
  | "run-mode"
  | "secret-key"
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
      "A code wiki for this local repository. Prioritize a concise quickstart, architecture overview, source map, key workflows, domain concepts, operations/runbook notes, testing guidance, and integration points. Inspect git history to understand reasoning behind code changes and the progression of the repository. Keep pages grounded in the repository structure and recent code changes. Prefer practical navigation for engineers over generic summaries.",
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
const FINAL_OPTIONS = ["Run ingestion now", "Run later"] as const;
const CODE_REPO_OPTIONS = ["Confirm and continue", "Edit path"] as const;

export function needsCredentialSetup(
  modelIdOverride: string | null = null,
  mode: OpenWikiRunMode = "personal",
): boolean {
  const provider = resolveConfiguredProvider();

  const needsCredentials =
    !hasValidConfiguredProvider() ||
    needsCredentialStep(provider) ||
    needsSecretKeyStep(provider) ||
    needsBaseUrlStep(provider) ||
    needsRegionStep(provider) ||
    (modelIdOverride === null &&
      process.env[OPENWIKI_MODEL_ID_ENV_KEY] === undefined) ||
    !process.env.LANGSMITH_API_KEY;

  if (needsCredentials) {
    return true;
  }

  return mode === "code"
    ? !isRepositoryCodeOnboardingCompleteSync(getDefaultCodeRepoRootPath())
    : !isOpenWikiOnboardingCompleteSync();
}

/**
 * Whether the provider still needs its primary credential collected. For
 * `oauth` providers this is a valid, non-expired stored token; for API-key
 * providers it is a pasted key; for keyless providers (gemini-enterprise) it is
 * the required GCP project id.
 */
function needsCredentialStep(provider: OpenWikiProvider): boolean {
  return providerUsesOAuth(provider)
    ? !hasValidStoredToken()
    : getMissingProviderEnvKey(provider) !== null;
}

/** The step that collects the provider's primary credential. */
function credentialStep(provider: OpenWikiProvider): PromptStep {
  if (providerUsesOAuth(provider)) {
    return "oauth-login";
  }

  return providerRequiresApiKey(provider) ? "api-key" : "gcp-project";
}

/**
 * Every managed env key the wizard lets you set for a provider, in checklist
 * order: the provider selection, its credential keys, the model, and the
 * LangSmith tracing key. Used to detect which of them a shell export is
 * currently shadowing (a shell var wins at runtime and would silently override
 * the choice made here). Returns key names only, never values.
 */
function getWizardManagedEnvKeys(provider: OpenWikiProvider): string[] {
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
  steps.push(primary);

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

function hasValidStoredToken(env: NodeJS.ProcessEnv = process.env): boolean {
  const tokens = readCodexTokensFromEnv(env);

  return tokens !== null && !isChatGptTokenExpired(tokens.expiresAtMs);
}

function needsGcpProjectStep(provider: OpenWikiProvider): boolean {
  const projectEnvKey = getProviderProjectEnvKey(provider);

  return projectEnvKey ? !process.env[projectEnvKey] : false;
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

function needsSecretKeyStep(provider: OpenWikiProvider): boolean {
  if (!providerRequiresSecretKey(provider)) {
    return false;
  }

  return !isSecretKeyConfigured(provider);
}

function isSecretKeyConfigured(provider: OpenWikiProvider): boolean {
  const secretKeyEnvKey = getProviderSecretKeyEnvKey(provider);

  return secretKeyEnvKey ? Boolean(process.env[secretKeyEnvKey]) : false;
}

function needsRegionStep(provider: OpenWikiProvider): boolean {
  if (!providerRequiresRegion(provider)) {
    return false;
  }

  return !isRegionConfigured(provider);
}

function isRegionConfigured(provider: OpenWikiProvider): boolean {
  const regionEnvKey = getProviderRegionEnvKey(provider);

  return regionEnvKey ? Boolean(process.env[regionEnvKey]) : false;
}

function isCredentialConfigured(provider: OpenWikiProvider): boolean {
  return providerUsesOAuth(provider)
    ? hasValidStoredToken()
    : getMissingProviderEnvKey(provider) === null;
}

function getCredentialSetupDetail(
  provider: OpenWikiProvider,
  tokens: CodexTokens | null = null,
): string {
  if (providerUsesOAuth(provider)) {
    if (!isCredentialConfigured(provider) && !tokens) {
      return "sign in with your ChatGPT account";
    }

    const account = formatChatGptAccount(
      tokens?.email ?? process.env[OPENAI_CHATGPT_EMAIL_ENV_KEY] ?? null,
      tokens?.planType ?? process.env[OPENAI_CHATGPT_PLAN_ENV_KEY] ?? null,
    );

    return account ? `signed in as ${account}` : "signed in with ChatGPT";
  }

  const apiKeyEnvKey = getProviderApiKeyEnvKey(provider);

  return isCredentialConfigured(provider)
    ? "available from environment"
    : apiKeyEnvKey
      ? `save ${apiKeyEnvKey} to ${openWikiEnvPath}`
      : "configure Google Cloud credentials";
}

/**
 * Copies text to the terminal's clipboard using the OSC 52 escape sequence.
 * This targets the user's local terminal emulator even when OpenWiki runs over
 * SSH, unlike shelling out to a host clipboard utility.
 */
function copyToClipboard(text: string): void {
  const encoded = Buffer.from(text, "utf8").toString("base64");

  process.stdout.write(`\u001b]52;c;${encoded}\u0007`);
}

function openLoginUrl(url: string): void {
  try {
    const child =
      process.platform === "win32"
        ? spawn("cmd", ["/c", "start", '""', `"${url}"`], {
            detached: true,
            stdio: "ignore",
            windowsVerbatimArguments: true,
          })
        : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
            detached: true,
            stdio: "ignore",
          });

    child.on("error", () => {
      // The URL is also rendered for manual use on headless/SSH machines.
    });
    child.unref();
  } catch {
    // Ignore spawn failures; the URL is still rendered for manual use.
  }
}

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

    if (step === "api-key") {
      const trimmedInput = input.trim();
      // Empty submit keeps an existing key (session or env); only a genuinely
      // missing key is an error.
      const nextApiKey = trimmedInput.length > 0 ? trimmedInput : apiKey;

      if (nextApiKey === null && !isCredentialConfigured(provider)) {
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
        nextSetupStep("api-key", provider, selectedMode, allowModeSelection) ??
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

      if (trimmedInput.length === 0) {
        setError(
          `${getProviderRegionEnvKey(provider) ?? "Region"} is required.`,
        );
        return;
      }

      setRegion(trimmedInput);
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
        nextRegion: trimmedInput,
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

      if (!isValidBaseUrl(trimmedInput)) {
        setError("Enter a valid http(s) base URL.");
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

    // Walk the wiki-goal step on --init even when set; otherwise only when
    // unset. Seed the existing goal so Enter keeps it (idempotent).
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
    needsCredentialStep(provider) ||
    needsSecretKeyStep(provider) ||
    needsBaseUrlStep(provider) ||
    needsRegionStep(provider) ||
    (modelIdOverride === null &&
      process.env[OPENWIKI_MODEL_ID_ENV_KEY] === undefined) ||
    !process.env.LANGSMITH_API_KEY;
  const apiKeyEnvKey = getProviderApiKeyEnvKey(provider);
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
          {providerUsesOAuth(provider) || apiKeyEnvKey ? (
            <SetupStep
              label={
                providerUsesOAuth(provider) ? "ChatGPT login" : "Provider key"
              }
              state={resolveStepStatus(
                credentialStep(provider),
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
              codeRepoSelectionIndex={codeRepoSelectionIndex}
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
    return (
      <Box flexDirection="column">
        <Text>Enter the {getProviderLabel(provider)} region.</Text>
        <Text>
          <Text color="gray">$</Text> {getProviderRegionEnvKey(provider)}={" "}
          <Text color="yellow">{input}</Text>
        </Text>
        <Text color="gray">For example us-east-1. Press Enter to save it.</Text>
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

type SetupStepState = "current" | "done" | "optional" | "pending";

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

/**
 * Progress glyph per status: a check for done, an arrow for the active row, a
 * hollow circle for not-started (and optional). Single cell wide so every row's
 * label column lines up without padding the marker.
 */
const STEP_GLYPH: Record<SetupStepState, string> = {
  done: "✓",
  current: "❯",
  optional: "○",
  pending: "○",
};

/** Color per status. Optionality is conveyed by the detail text, not the glyph. */
const STEP_COLOR: Record<SetupStepState, string> = {
  done: "green",
  current: "cyan",
  optional: "gray",
  pending: "gray",
};

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

function formatSecretInputDisplay(value: string): string {
  // Empty renders as nothing (just the cursor); dots for the entered length,
  // matching the non-secret inputs rather than printing a literal "empty".
  return "•".repeat(value.length);
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

  if (needsCredentialStep(provider)) {
    return credentialStep(provider);
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
  if (needsCredentialStep(provider)) {
    return credentialStep(provider);
  }

  return getNextStepAfterApiKey(
    provider,
    modelIdOverride,
    onboardingConfig,
    mode,
    forceModelStep,
  );
}

function getNextStepAfterApiKey(
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

function getNextStepAfterSecretKey(
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

function getNextStepAfterGcpLocation(
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

function getNextStepAfterBaseUrl(
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

function getNextStepAfterRegion(
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

function ensureRunModeConfig(
  config: OpenWikiOnboardingConfig,
  mode: OpenWikiRunMode,
): OpenWikiOnboardingConfig {
  if (getConfigModeId(config) === mode) {
    return config;
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
  };
}

async function hydrateRunModeConfig(
  config: OpenWikiOnboardingConfig,
  mode: OpenWikiRunMode,
  repoRoot: string,
): Promise<OpenWikiOnboardingConfig> {
  if (mode !== "code") {
    return config;
  }

  const wikiGoal = await readRepositoryWikiInstructions(repoRoot);

  return wikiGoal ? { ...config, wikiGoal } : config;
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

function getDefaultCodeRepoRootPath(): string {
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
