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
export const AZURE_OPENAI_API_KEY_ENV_KEY = "AZURE_OPENAI_API_KEY";
export const AZURE_OPENAI_ENDPOINT_ENV_KEY = "AZURE_OPENAI_ENDPOINT";
export const AZURE_OPENAI_API_VERSION_ENV_KEY = "AZURE_OPENAI_API_VERSION";
export const AZURE_OPENAI_USE_AD_TOKEN_ENV_KEY = "AZURE_OPENAI_USE_AD_TOKEN";
export const DEFAULT_AZURE_OPENAI_API_VERSION = "2024-12-01-preview";
export const OPENWIKI_PROVIDER_ENV_KEY = "OPENWIKI_PROVIDER";
export const OPENWIKI_MODEL_ID_ENV_KEY = "OPENWIKI_MODEL_ID";
export const DEFAULT_PROVIDER = "openrouter";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export type OpenWikiProvider =
  | "anthropic"
  | "azure"
  | "baseten"
  | "fireworks"
  | "openai"
  | "openai-compatible"
  | "openrouter";

export type SelectableOpenWikiProvider = OpenWikiProvider;

export type ProviderModelOption = {
  id: string;
  label: string;
};

type ProviderConfig = {
  /**
   * Environment variable holding the provider's API key. Absent when the
   * provider can authenticate without an API key (e.g. Microsoft Entra ID
   * bearer tokens for Azure OpenAI).
   */
  apiKeyEnvKey?: string;
  baseURL?: string;
  /**
   * Environment variable that, when set, overrides {@link ProviderConfig.baseURL}
   * with an alternative base URL (e.g. a self-hosted or proxied endpoint).
   */
  baseUrlEnvKey?: string;
  /**
   * When true, the provider has no default endpoint and requires a base URL to
   * be supplied via {@link ProviderConfig.baseUrlEnvKey}.
   */
  requiresBaseUrl?: boolean;
  /**
   * Environment variable holding the provider endpoint required to run it
   * (e.g. an Azure OpenAI resource endpoint). Unlike {@link ProviderConfig.baseUrlEnvKey}
   * this is mandatory, and the provider authenticates against it with either an
   * API key or a bearer token rather than an OpenAI-style base URL.
   */
  endpointEnvKey?: string;
  label: string;
  modelOptions: ProviderModelOption[];
};

export const SELECTABLE_OPENWIKI_PROVIDERS = [
  "openrouter",
  "baseten",
  "fireworks",
  "openai",
  "openai-compatible",
  "anthropic",
  "azure",
] as const satisfies readonly SelectableOpenWikiProvider[];

export const PROVIDER_CONFIGS: Record<OpenWikiProvider, ProviderConfig> = {
  baseten: {
    apiKeyEnvKey: BASETEN_API_KEY_ENV_KEY,
    baseURL: "https://inference.baseten.co/v1",
    label: "Baseten",
    modelOptions: [
      { id: "zai-org/GLM-5.2", label: "GLM 5.2" },
      { id: "moonshotai/Kimi-K2.7-Code", label: "Kimi K2.7 Code" },
    ],
  },
  fireworks: {
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
  openai: {
    apiKeyEnvKey: OPENAI_API_KEY_ENV_KEY,
    label: "OpenAI",
    modelOptions: [
      { id: "gpt-5.4-mini", label: "5.4 mini" },
      { id: "gpt-5.5", label: "5.5" },
    ],
  },
  "openai-compatible": {
    apiKeyEnvKey: OPENAI_COMPATIBLE_API_KEY_ENV_KEY,
    baseUrlEnvKey: OPENAI_COMPATIBLE_BASE_URL_ENV_KEY,
    requiresBaseUrl: true,
    label: "OpenAI-compatible",
    modelOptions: [],
  },
  anthropic: {
    apiKeyEnvKey: ANTHROPIC_API_KEY_ENV_KEY,
    baseUrlEnvKey: ANTHROPIC_BASE_URL_ENV_KEY,
    label: "Anthropic",
    modelOptions: [
      { id: "claude-haiku-4-5", label: "Haiku" },
      { id: "claude-sonnet-5", label: "Sonnet" },
      { id: "claude-opus-4-8", label: "Opus" },
    ],
  },
  azure: {
    apiKeyEnvKey: AZURE_OPENAI_API_KEY_ENV_KEY,
    endpointEnvKey: AZURE_OPENAI_ENDPOINT_ENV_KEY,
    label: "Azure OpenAI",
    // Azure routes by deployment name, not base model. OpenWiki carries that
    // deployment name through OPENWIKI_MODEL_ID (as the openai-compatible
    // provider does for gateway model names), so there are no presets — the
    // deployment name is always user-supplied.
    modelOptions: [],
  },
  openrouter: {
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

export const OPENROUTER_FALLBACK_MODEL_IDS = [
  "openai/gpt-5.4-mini",
  "anthropic/claude-sonnet-5",
];

export const SUGGESTED_MODEL_IDS = PROVIDER_CONFIGS[
  DEFAULT_PROVIDER
].modelOptions.map((model) => model.id);

export function getProviderConfig(provider: OpenWikiProvider): ProviderConfig {
  return PROVIDER_CONFIGS[provider];
}

export function getProviderLabel(provider: OpenWikiProvider): string {
  return getProviderConfig(provider).label;
}

export function getProviderApiKeyEnvKey(
  provider: OpenWikiProvider,
): string | undefined {
  return getProviderConfig(provider).apiKeyEnvKey;
}

export function getProviderEndpointEnvKey(
  provider: OpenWikiProvider,
): string | undefined {
  return getProviderConfig(provider).endpointEnvKey;
}

/**
 * Whether the provider can authenticate with a Microsoft Entra ID bearer token
 * (via `DefaultAzureCredential`) instead of an API key. For such providers the
 * API key is optional — a token is used when no key is present.
 */
export function providerSupportsAdToken(provider: OpenWikiProvider): boolean {
  return provider === "azure";
}

/**
 * Whether the provider strictly requires its API key to run. False for
 * providers with no API key at all, and for providers that can fall back to a
 * bearer token (see {@link providerSupportsAdToken}).
 */
export function providerRequiresApiKey(provider: OpenWikiProvider): boolean {
  return (
    getProviderConfig(provider).apiKeyEnvKey !== undefined &&
    !providerSupportsAdToken(provider)
  );
}

/**
 * Resolves whether the azure provider should authenticate with an Entra ID
 * bearer token rather than an API key: when `AZURE_OPENAI_USE_AD_TOKEN` is
 * truthy, or when no `AZURE_OPENAI_API_KEY` is set (the token is the default
 * fallback, matching the "no key" story).
 */
export function azureUsesAdToken(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const flag = env[AZURE_OPENAI_USE_AD_TOKEN_ENV_KEY]?.trim().toLowerCase();

  if (flag === "true" || flag === "1" || flag === "yes") {
    return true;
  }

  return !env[AZURE_OPENAI_API_KEY_ENV_KEY];
}

/**
 * Returns the first required-but-unset environment variable for a provider (its
 * endpoint, then its API key when strictly required), or `null` when the
 * provider has everything it needs to run. Base URL requirements are checked
 * separately via {@link providerRequiresBaseUrl}.
 */
export function getMissingProviderEnvKey(
  provider: OpenWikiProvider,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const config = getProviderConfig(provider);

  if (config.endpointEnvKey && !env[config.endpointEnvKey]) {
    return config.endpointEnvKey;
  }

  if (
    config.apiKeyEnvKey &&
    !env[config.apiKeyEnvKey] &&
    providerRequiresApiKey(provider)
  ) {
    return config.apiKeyEnvKey;
  }

  return null;
}

/**
 * A human-readable hint for providers whose credentials live outside the
 * OpenWiki env file, appended to missing-credential error messages.
 */
export function getProviderCredentialHint(
  provider: OpenWikiProvider,
): string | null {
  if (provider === "azure") {
    return (
      "Without an API key, the azure provider authenticates with a Microsoft " +
      "Entra ID bearer token via DefaultAzureCredential — sign in with " +
      "`az login`, or provide managed/workload identity, or set " +
      `${AZURE_OPENAI_API_KEY_ENV_KEY} for key-based auth.`
    );
  }

  return null;
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
  return getProviderConfig(provider).baseUrlEnvKey;
}

export function providerRequiresBaseUrl(provider: OpenWikiProvider): boolean {
  return getProviderConfig(provider).requiresBaseUrl === true;
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

export const OPENWIKI_VERSION = "0.0.1";
