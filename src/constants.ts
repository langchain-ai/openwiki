export const OPEN_WIKI_DIR = "openwiki";
export const UPDATE_METADATA_PATH = `${OPEN_WIKI_DIR}/.last-update.json`;
export const BASETEN_API_KEY_ENV_KEY = "BASETEN_API_KEY";
export const FIREWORKS_API_KEY_ENV_KEY = "FIREWORKS_API_KEY";
export const OPENAI_API_KEY_ENV_KEY = "OPENAI_API_KEY";
export const OPENAI_COMPATIBLE_API_KEY_ENV_KEY = "OPENAI_COMPATIBLE_API_KEY";
export const OPENAI_COMPATIBLE_BASE_URL_ENV_KEY = "OPENAI_COMPATIBLE_BASE_URL";
export const ANTHROPIC_API_KEY_ENV_KEY = "ANTHROPIC_API_KEY";
export const ANTHROPIC_BASE_URL_ENV_KEY = "ANTHROPIC_BASE_URL";
export const OPENROUTER_API_KEY_ENV_KEY = "OPENROUTER_API_KEY";
export const CLAUDE_CODE_BINARY_ENV_KEY = "OPENWIKI_CLAUDE_CODE_BINARY";
export const IBM_BOB_BINARY_ENV_KEY = "OPENWIKI_IBM_BOB_BINARY";
export const OPENWIKI_PROVIDER_ENV_KEY = "OPENWIKI_PROVIDER";
export const OPENWIKI_MODEL_ID_ENV_KEY = "OPENWIKI_MODEL_ID";
export const DEFAULT_PROVIDER = "openrouter";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export type OpenWikiProvider =
  | "anthropic"
  | "baseten"
  | "claude-code"
  | "fireworks"
  | "ibm-bob"
  | "openai"
  | "openai-compatible"
  | "openrouter";

export type SelectableOpenWikiProvider = OpenWikiProvider;

export type ProviderModelOption = {
  id: string;
  label: string;
};

export type ApiProviderConfig = {
  kind: "api";
  apiKeyEnvKey: string;
  baseURL?: string;
  /**
   * Environment variable that, when set, overrides {@link ApiProviderConfig.baseURL}
   * with an alternative base URL (e.g. a self-hosted or proxied endpoint).
   */
  baseUrlEnvKey?: string;
  /**
   * When true, the provider has no default endpoint and requires a base URL to
   * be supplied via {@link ApiProviderConfig.baseUrlEnvKey}.
   */
  requiresBaseUrl?: boolean;
  label: string;
  modelOptions: ProviderModelOption[];
};

export type AgentCliProviderConfig = {
  kind: "agent-cli";
  /** Environment variable that overrides the default binary path. */
  binaryEnvKey: string;
  defaultBinary: string;
  /** Shown when the binary is missing or not logged in. */
  installHint: string;
  label: string;
  modelOptions: ProviderModelOption[];
};

type ProviderConfig = ApiProviderConfig | AgentCliProviderConfig;

export const SELECTABLE_OPENWIKI_PROVIDERS = [
  "openrouter",
  "baseten",
  "fireworks",
  "openai",
  "openai-compatible",
  "anthropic",
  "claude-code",
  "ibm-bob",
] as const satisfies readonly SelectableOpenWikiProvider[];

export const PROVIDER_CONFIGS: Record<OpenWikiProvider, ProviderConfig> = {
  baseten: {
    kind: "api",
    apiKeyEnvKey: BASETEN_API_KEY_ENV_KEY,
    baseURL: "https://inference.baseten.co/v1",
    label: "Baseten",
    modelOptions: [
      { id: "zai-org/GLM-5.2", label: "GLM 5.2" },
      { id: "moonshotai/Kimi-K2.7-Code", label: "Kimi K2.7 Code" },
    ],
  },
  "claude-code": {
    kind: "agent-cli",
    binaryEnvKey: CLAUDE_CODE_BINARY_ENV_KEY,
    defaultBinary: "claude",
    installHint:
      "Install Claude Code (npm install -g @anthropic-ai/claude-code), then run `claude` once and complete the subscription login.",
    label: "Claude Code (subscription)",
    modelOptions: [
      { id: "default", label: "Subscription default" },
      { id: "sonnet", label: "Sonnet" },
      { id: "opus", label: "Opus" },
      { id: "haiku", label: "Haiku" },
    ],
  },
  fireworks: {
    kind: "api",
    apiKeyEnvKey: FIREWORKS_API_KEY_ENV_KEY,
    baseURL: "https://api.fireworks.ai/inference/v1",
    label: "Fireworks",
    modelOptions: [
      { id: "accounts/fireworks/models/glm-5p2", label: "GLM 5.2" },
      {
        id: "accounts/fireworks/models/kimi-k2p7-code",
        label: "Kimi K2.7 Code",
      },
    ],
  },
  "ibm-bob": {
    kind: "agent-cli",
    binaryEnvKey: IBM_BOB_BINARY_ENV_KEY,
    defaultBinary: "bob",
    installHint:
      "Install Bob Shell (curl -fsSL https://bob.ibm.com/download/bobshell.sh | bash), run `bob` once in this repository to complete the IBMid login, and trust the folder when prompted.",
    label: "IBM Bob (subscription)",
    modelOptions: [{ id: "default", label: "Subscription default" }],
  },
  openai: {
    kind: "api",
    apiKeyEnvKey: OPENAI_API_KEY_ENV_KEY,
    label: "OpenAI",
    modelOptions: [
      { id: "gpt-5.4-mini", label: "5.4 mini" },
      { id: "gpt-5.5", label: "5.5" },
    ],
  },
  "openai-compatible": {
    kind: "api",
    apiKeyEnvKey: OPENAI_COMPATIBLE_API_KEY_ENV_KEY,
    baseUrlEnvKey: OPENAI_COMPATIBLE_BASE_URL_ENV_KEY,
    requiresBaseUrl: true,
    label: "OpenAI-compatible",
    modelOptions: [],
  },
  anthropic: {
    kind: "api",
    apiKeyEnvKey: ANTHROPIC_API_KEY_ENV_KEY,
    baseUrlEnvKey: ANTHROPIC_BASE_URL_ENV_KEY,
    label: "Anthropic",
    modelOptions: [
      { id: "claude-haiku-4-5", label: "Haiku" },
      { id: "claude-sonnet-5", label: "Sonnet" },
      { id: "claude-opus-4-8", label: "Opus" },
    ],
  },
  openrouter: {
    kind: "api",
    apiKeyEnvKey: OPENROUTER_API_KEY_ENV_KEY,
    baseURL: OPENROUTER_BASE_URL,
    label: "OpenRouter",
    modelOptions: [
      { id: "z-ai/glm-5.2", label: "GLM 5.2" },
      { id: "openrouter/fusion", label: "OpenRouter Fusion" },
      { id: "moonshotai/kimi-k2.7-code", label: "Kimi K2.7 Code" },
      { id: "anthropic/claude-opus-4-8", label: "Claude Opus" },
      { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet" },
      { id: "openai/gpt-5.4-mini", label: "GPT 5.4 mini" },
      { id: "openai/gpt-5.5", label: "GPT 5.5" },
    ],
  },
};

export const DEFAULT_MODEL_ID =
  PROVIDER_CONFIGS[DEFAULT_PROVIDER].modelOptions[0]?.id ?? "zai-org/GLM-5.2";

export const SUGGESTED_MODEL_IDS = PROVIDER_CONFIGS[
  DEFAULT_PROVIDER
].modelOptions.map((model) => model.id);

export function getProviderConfig(provider: OpenWikiProvider): ProviderConfig {
  return PROVIDER_CONFIGS[provider];
}

export function getProviderLabel(provider: OpenWikiProvider): string {
  return getProviderConfig(provider).label;
}

export function isAgentCliProvider(provider: OpenWikiProvider): boolean {
  return getProviderConfig(provider).kind === "agent-cli";
}

export function getAgentCliProviderConfig(
  provider: OpenWikiProvider,
): AgentCliProviderConfig {
  const config = getProviderConfig(provider);

  if (config.kind !== "agent-cli") {
    throw new Error(`${provider} is not an agent CLI provider.`);
  }

  return config;
}

function getApiProviderConfig(provider: OpenWikiProvider): ApiProviderConfig {
  const config = getProviderConfig(provider);

  if (config.kind !== "api") {
    throw new Error(
      `${provider} is an agent CLI provider and has no API key configuration.`,
    );
  }

  return config;
}

export function getProviderApiKeyEnvKey(provider: OpenWikiProvider): string {
  return getApiProviderConfig(provider).apiKeyEnvKey;
}

/**
 * Resolves the base URL for a provider, preferring an alternative base URL from
 * the provider's configured environment variable over the built-in default.
 * Returns `undefined` when neither is set, so callers fall back to the SDK's
 * own default endpoint.
 */
export function resolveProviderBaseUrl(
  provider: OpenWikiProvider,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const config = getProviderConfig(provider);

  if (config.kind !== "api") {
    return undefined;
  }

  const override = config.baseUrlEnvKey ? env[config.baseUrlEnvKey] : undefined;
  const trimmedOverride = override?.trim();

  if (trimmedOverride) {
    return trimmedOverride;
  }

  return config.baseURL;
}

export function getProviderBaseUrlEnvKey(
  provider: OpenWikiProvider,
): string | undefined {
  const config = getProviderConfig(provider);

  return config.kind === "api" ? config.baseUrlEnvKey : undefined;
}

export function providerRequiresBaseUrl(provider: OpenWikiProvider): boolean {
  const config = getProviderConfig(provider);

  return config.kind === "api" && config.requiresBaseUrl === true;
}

export function isValidBaseUrl(value: string): boolean {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return false;
  }

  try {
    const url = new URL(trimmed);

    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function getProviderModelOptions(
  provider: OpenWikiProvider,
): ProviderModelOption[] {
  return getProviderConfig(provider).modelOptions;
}

export function getDefaultModelId(provider: OpenWikiProvider): string {
  return getProviderModelOptions(provider)[0]?.id ?? DEFAULT_MODEL_ID;
}

/**
 * Composes the in-session notice shown after switching providers. Agent CLI
 * providers have no API key, so their notice points at the local CLI login
 * instead of an API-key environment variable.
 */
export function formatProviderSwitchNotice(provider: OpenWikiProvider): string {
  const switched = `Provider switched to ${getProviderLabel(provider)} with model ${getDefaultModelId(provider)}.`;

  if (isAgentCliProvider(provider)) {
    return `${switched} Runs use the local agent CLI login.`;
  }

  return `${switched} Ensure ${getProviderApiKeyEnvKey(provider)} is set.`;
}

export function normalizeProvider(
  value: string | null | undefined,
): OpenWikiProvider | null {
  if (value === undefined || value === null) {
    return null;
  }

  const provider = value.trim().toLowerCase();

  return isValidProvider(provider) ? provider : null;
}

export function isValidProvider(value: string): value is OpenWikiProvider {
  return value in PROVIDER_CONFIGS;
}

export function resolveConfiguredProvider(
  env: NodeJS.ProcessEnv = process.env,
): OpenWikiProvider {
  return (
    normalizeProvider(env[OPENWIKI_PROVIDER_ENV_KEY]) ??
    (env[OPENROUTER_API_KEY_ENV_KEY] ? "openrouter" : DEFAULT_PROVIDER)
  );
}

export function normalizeModelId(value: string): string {
  return value.trim();
}

export function isValidModelId(value: string): boolean {
  const modelId = normalizeModelId(value);

  return (
    modelId.length > 0 &&
    modelId.length <= 120 &&
    /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/u.test(modelId) &&
    !modelId.includes("://")
  );
}

export const OPENWIKI_VERSION = "0.0.4";
