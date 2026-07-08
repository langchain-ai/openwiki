export const OPEN_WIKI_DIR = "openwiki";
export const UPDATE_METADATA_PATH = `${OPEN_WIKI_DIR}/.last-update.json`;
export const BASETEN_API_KEY_ENV_KEY = "BASETEN_API_KEY";
export const FIREWORKS_API_KEY_ENV_KEY = "FIREWORKS_API_KEY";
export const OPENAI_API_KEY_ENV_KEY = "OPENAI_API_KEY";
export const OPENAI_COMPATIBLE_API_KEY_ENV_KEY = "OPENAI_COMPATIBLE_API_KEY";
export const OPENAI_COMPATIBLE_BASE_URL_ENV_KEY = "OPENAI_COMPATIBLE_BASE_URL";
export const OPENAI_COMPATIBLE_AUTH_ENV_KEY = "OPENAI_COMPATIBLE_AUTH";
export const ANTHROPIC_API_KEY_ENV_KEY = "ANTHROPIC_API_KEY";
export const ANTHROPIC_BASE_URL_ENV_KEY = "ANTHROPIC_BASE_URL";
export const OPENROUTER_API_KEY_ENV_KEY = "OPENROUTER_API_KEY";
export const OPENWIKI_PROVIDER_ENV_KEY = "OPENWIKI_PROVIDER";
export const OPENWIKI_MODEL_ID_ENV_KEY = "OPENWIKI_MODEL_ID";
export const DEFAULT_PROVIDER = "openrouter";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export type OpenWikiProvider =
  | "anthropic"
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
  apiKeyEnvKey: string;
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

export const SUGGESTED_MODEL_IDS = PROVIDER_CONFIGS[
  DEFAULT_PROVIDER
].modelOptions.map((model) => model.id);

export function getProviderConfig(provider: OpenWikiProvider): ProviderConfig {
  return PROVIDER_CONFIGS[provider];
}

export function getProviderLabel(provider: OpenWikiProvider): string {
  return getProviderConfig(provider).label;
}

export function getProviderApiKeyEnvKey(provider: OpenWikiProvider): string {
  return getProviderConfig(provider).apiKeyEnvKey;
}

/**
 * Whether the provider needs a static API key configured to run. Normally true,
 * but the openai-compatible provider in a token-based auth mode (e.g.
 * `entra-id`) authenticates without one.
 */
export function providerRequiresApiKey(
  provider: OpenWikiProvider,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (provider === "openai-compatible") {
    return resolveOpenAICompatibleAuthMode(env) === "api-key";
  }

  return true;
}

/**
 * Whether the provider has a usable credential configured: a static API key,
 * or a non-key auth mode (e.g. openai-compatible with `entra-id`) that obtains
 * its token at request time.
 */
export function hasProviderCredential(
  provider: OpenWikiProvider,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!providerRequiresApiKey(provider, env)) {
    return true;
  }

  return Boolean(env[getProviderApiKeyEnvKey(provider)]);
}

/**
 * Describes the missing-credential requirement for a provider, naming every way
 * to satisfy it. For openai-compatible this includes the token-based auth mode
 * (`entra-id`) alongside the static API key, so users who cannot (or do not want
 * to) store a key learn about the alternative.
 */
export function describeMissingCredential(provider: OpenWikiProvider): string {
  const apiKeyEnvKey = getProviderApiKeyEnvKey(provider);

  if (provider === "openai-compatible") {
    return (
      `${apiKeyEnvKey}, or ${OPENAI_COMPATIBLE_AUTH_ENV_KEY}=entra-id ` +
      "to authenticate with a Microsoft Entra ID token,"
    );
  }

  return apiKeyEnvKey;
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

/**
 * How the openai-compatible provider authenticates against its endpoint:
 * - `api-key` — a static bearer key sent as the OpenAI API key (default),
 * - `entra-id` — a Microsoft Entra ID access token, fetched (and refreshed)
 *   via Azure `DefaultAzureCredential`, for endpoints that accept Entra ID
 *   tokens such as Azure OpenAI's OpenAI-compatible `/openai/v1` API.
 *
 * The mode is an extension point: additional token-based mechanisms can be
 * added here without introducing per-cloud providers.
 */
export type OpenAICompatibleAuthMode = "api-key" | "entra-id";

export const DEFAULT_OPENAI_COMPATIBLE_AUTH_MODE: OpenAICompatibleAuthMode =
  "api-key";

const OPENAI_COMPATIBLE_AUTH_MODES: readonly OpenAICompatibleAuthMode[] = [
  "api-key",
  "entra-id",
];

export function isValidOpenAICompatibleAuthMode(
  value: string,
): value is OpenAICompatibleAuthMode {
  return (OPENAI_COMPATIBLE_AUTH_MODES as readonly string[]).includes(value);
}

export function normalizeOpenAICompatibleAuthMode(
  value: string | null | undefined,
): OpenAICompatibleAuthMode | null {
  if (value === undefined || value === null) {
    return null;
  }

  const mode = value.trim().toLowerCase();

  return isValidOpenAICompatibleAuthMode(mode) ? mode : null;
}

/**
 * Resolves the configured openai-compatible auth mode, falling back to the
 * default (`api-key`) when the variable is unset. An explicitly-set but invalid
 * value returns `null` so callers can surface a configuration error.
 */
export function resolveOpenAICompatibleAuthMode(
  env: NodeJS.ProcessEnv = process.env,
): OpenAICompatibleAuthMode | null {
  const raw = env[OPENAI_COMPATIBLE_AUTH_ENV_KEY];

  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_OPENAI_COMPATIBLE_AUTH_MODE;
  }

  return normalizeOpenAICompatibleAuthMode(raw);
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

export const OPENWIKI_VERSION = "0.0.2";
