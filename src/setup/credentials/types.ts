import type { CodexTokens } from "../../agent/openai-chatgpt-oauth.js";
import type { OpenWikiRunMode } from "../../cli/commands.js";
import type { OpenWikiProvider } from "../../config/constants.js";
import type { ReasoningEffort } from "../../config/reasoning.js";
import type { AuthProviderId } from "../../auth/types.js";
import type { ConnectorId } from "../../connectors/types.js";
import type { LangSmithRegion } from "../../connectors/sources/langsmith/setup.js";

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

export type InitSetupProps = {
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

export type PromptStep =
  | "api-key"
  | "base-url"
  | "code-repo-confirm"
  | "code-repo-path"
  | "external-cli-auth"
  | "final"
  | "gcp-location"
  | "gcp-project"
  | "langsmith"
  | "model"
  | "oauth-login"
  | "provider"
  | "reasoning-effort"
  | "region"
  | "run-mode"
  | "secret-key"
  | "source-auth"
  | "global-cron-custom"
  | "global-cron-mode"
  | "global-power-mode"
  | "source-description"
  | "source-description-custom"
  | "source-langsmith-key"
  | "source-langsmith-projects"
  | "source-langsmith-region"
  | "source-langsmith-workspaces"
  | "source-menu"
  | "source-path"
  | "source-confirm-continue"
  | "source-secret"
  | "template"
  | "wiki-goal";

export type SourceSetupOption = {
  authProvider?: AuthProviderId;
  displayName: string;
  examples: string[];
  id: ConnectorId;
  instructions: string[];
  secretInputs: SourceSecretInput[];
};

export type SourceSecretInput = {
  envKey: string;
  label: string;
  optional?: boolean;
  secret?: boolean;
};

export type SourceSetupState = {
  authUrl?: string;
  connectorConfig?: Record<string, unknown>;
  copiedAuthUrlToClipboard?: boolean;
  savedScheduleWarning?: string;
  secretValues: Record<string, string>;
};

export type PromptInputKey = {
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

export type ModelSelectionOption =
  | {
      id: string;
      kind: "preset";
      label: string;
    }
  | {
      kind: "custom";
    };

/** An explicit provider default is persisted as an empty environment value. */
export type ReasoningEffortSelection = "" | ReasoningEffort;

export type OnboardingMode = {
  description: string;
  id: string;
  name: string;
  sourceIds: ConnectorId[];
  suggestedSources: string[];
  suggestedGoal: string;
};

/**
 * One LangSmith workspace as the wizard edits it. `apiKey` holds a value entered
 * this session (empty = keep the committed key); it is written to ~/.openwiki/.env
 * under `apiKeyEnv` on completion, never committed.
 */
export interface LangsmithWorkspaceDraft {
  apiKeyEnv: string;
  region: LangSmithRegion;
  apiKey: string;
  projects: string[];
}

export type SetupStepState = "current" | "done" | "optional" | "pending";

/**
 * The credential/config values collected by the wizard that get persisted to
 * `~/.openwiki/.env` on completion. Each `next*` field is the value to write for
 * that provider setting, or null when the wizard did not collect one (in which
 * case that key is left untouched).
 */
export interface CompleteSetupOptions {
  nextApiKey: string | null;
  nextBaseUrl: string | null;
  nextGcpLocation: string | null;
  nextGcpProject: string | null;
  nextLangSmithKey: string | null;
  nextModelId: string | null;
  nextReasoningEffort?: ReasoningEffortSelection | null;

  /**
   * OAuth tokens to persist for providers that authenticate by browser login.
   *
   * @default the wizard's current `oauthTokens` state (resolved by the caller
   * when this field is omitted; an explicit null means "no tokens")
   */
  nextOAuthTokens?: CodexTokens | null;

  nextProvider: OpenWikiProvider;
  nextRegion: string | null;
  nextSecretKey: string | null;
  runMode: OpenWikiRunMode;
}
