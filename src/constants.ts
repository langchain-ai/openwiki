export const OPEN_WIKI_DIR = "openwiki";
export const UPDATE_METADATA_PATH = `${OPEN_WIKI_DIR}/.last-update.json`;
export const BASETEN_API_KEY_ENV_KEY = "BASETEN_API_KEY";
export const FIREWORKS_API_KEY_ENV_KEY = "FIREWORKS_API_KEY";
export const NEBIUS_API_KEY_ENV_KEY = "NEBIUS_API_KEY";
export const NVIDIA_API_KEY_ENV_KEY = "NVIDIA_API_KEY";
export const OPENAI_API_KEY_ENV_KEY = "OPENAI_API_KEY";
export const OPENAI_BASE_URL_ENV_KEY = "OPENAI_BASE_URL";
export const OPENAI_COMPATIBLE_API_KEY_ENV_KEY = "OPENAI_COMPATIBLE_API_KEY";
export const OPENAI_COMPATIBLE_BASE_URL_ENV_KEY = "OPENAI_COMPATIBLE_BASE_URL";
export const OPENAI_CHATGPT_ACCESS_TOKEN_ENV_KEY =
  "OPENAI_CHATGPT_ACCESS_TOKEN";
export const OPENAI_CHATGPT_REFRESH_TOKEN_ENV_KEY =
  "OPENAI_CHATGPT_REFRESH_TOKEN";
export const OPENAI_CHATGPT_EXPIRES_AT_ENV_KEY = "OPENAI_CHATGPT_EXPIRES_AT";
export const OPENAI_CHATGPT_ACCOUNT_ID_ENV_KEY = "OPENAI_CHATGPT_ACCOUNT_ID";
export const OPENAI_CHATGPT_EMAIL_ENV_KEY = "OPENAI_CHATGPT_EMAIL";
export const OPENAI_CHATGPT_PLAN_ENV_KEY = "OPENAI_CHATGPT_PLAN";
export const ANTHROPIC_API_KEY_ENV_KEY = "ANTHROPIC_API_KEY";
export const ANTHROPIC_BASE_URL_ENV_KEY = "ANTHROPIC_BASE_URL";
export const OPENROUTER_API_KEY_ENV_KEY = "OPENROUTER_API_KEY";
export const OPENWIKI_OPENROUTER_PROVIDER_ONLY_ENV_KEY =
  "OPENWIKI_OPENROUTER_PROVIDER_ONLY";
export const BEDROCK_AWS_ACCESS_KEY_ID_ENV_KEY = "BEDROCK_AWS_ACCESS_KEY_ID";
export const BEDROCK_AWS_SECRET_ACCESS_KEY_ENV_KEY =
  "BEDROCK_AWS_SECRET_ACCESS_KEY";
export const BEDROCK_AWS_REGION_ENV_KEY = "BEDROCK_AWS_REGION";
export const GEMINI_API_KEY_ENV_KEY = "GEMINI_API_KEY";
export const GOOGLE_CLOUD_PROJECT_ENV_KEY = "GOOGLE_CLOUD_PROJECT";
export const GOOGLE_CLOUD_LOCATION_ENV_KEY = "GOOGLE_CLOUD_LOCATION";
export const GOOGLE_APPLICATION_CREDENTIALS_ENV_KEY =
  "GOOGLE_APPLICATION_CREDENTIALS";
export const DEFAULT_VERTEX_LOCATION = "global";
export const GROK_BUILD_BINARY_ENV_KEY = "OPENWIKI_GROK_BUILD_BINARY";
export const OPENWIKI_PROVIDER_ENV_KEY = "OPENWIKI_PROVIDER";
export const OPENWIKI_MODEL_ID_ENV_KEY = "OPENWIKI_MODEL_ID";
export const NEBIUS_BASE_URL = "https://api.tokenfactory.nebius.com/v1/";
export const OPENWIKI_PROVIDER_RETRY_ATTEMPTS_ENV_KEY =
  "OPENWIKI_PROVIDER_RETRY_ATTEMPTS";
export const DEFAULT_PROVIDER_RETRY_ATTEMPTS = 3;
export const OPENWIKI_GOOGLE_ACCESS_TOKEN_ENV_KEY =
  "OPENWIKI_GOOGLE_ACCESS_TOKEN";
export const OPENWIKI_GOOGLE_CLIENT_ID_ENV_KEY = "OPENWIKI_GOOGLE_CLIENT_ID";
export const OPENWIKI_GOOGLE_CLIENT_SECRET_ENV_KEY =
  "OPENWIKI_GOOGLE_CLIENT_SECRET";
export const OPENWIKI_GOOGLE_REFRESH_TOKEN_ENV_KEY =
  "OPENWIKI_GOOGLE_REFRESH_TOKEN";
export const OPENWIKI_GMAIL_ACCESS_TOKEN_ENV_KEY =
  "OPENWIKI_GMAIL_ACCESS_TOKEN";
export const OPENWIKI_GMAIL_REFRESH_TOKEN_ENV_KEY =
  "OPENWIKI_GMAIL_REFRESH_TOKEN";
export const OPENWIKI_NOTION_MCP_ACCESS_TOKEN_ENV_KEY =
  "OPENWIKI_NOTION_MCP_ACCESS_TOKEN";
export const OPENWIKI_NOTION_MCP_CLIENT_ID_ENV_KEY =
  "OPENWIKI_NOTION_MCP_CLIENT_ID";
export const OPENWIKI_NOTION_MCP_REFRESH_TOKEN_ENV_KEY =
  "OPENWIKI_NOTION_MCP_REFRESH_TOKEN";
export const OPENWIKI_NOTION_TOKEN_ENV_KEY = "OPENWIKI_NOTION_TOKEN";
export const OPENWIKI_SLACK_BOT_TOKEN_ENV_KEY = "OPENWIKI_SLACK_BOT_TOKEN";
export const OPENWIKI_SLACK_CLIENT_ID_ENV_KEY = "OPENWIKI_SLACK_CLIENT_ID";
export const OPENWIKI_SLACK_CLIENT_SECRET_ENV_KEY =
  "OPENWIKI_SLACK_CLIENT_SECRET";
export const OPENWIKI_SLACK_USER_TOKEN_ENV_KEY = "OPENWIKI_SLACK_USER_TOKEN";
export const OPENWIKI_X_ACCESS_TOKEN_ENV_KEY = "OPENWIKI_X_ACCESS_TOKEN";
export const OPENWIKI_X_CLIENT_ID_ENV_KEY = "OPENWIKI_X_CLIENT_ID";
export const OPENWIKI_X_CLIENT_SECRET_ENV_KEY = "OPENWIKI_X_CLIENT_SECRET";
export const OPENWIKI_X_REFRESH_TOKEN_ENV_KEY = "OPENWIKI_X_REFRESH_TOKEN";
export const OPENWIKI_TAVILY_API_KEY_ENV_KEY = "TAVILY_API_KEY";
export const DEFAULT_PROVIDER = "openai";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export type OpenWikiProvider =
  | "anthropic"
  | "baseten"
  | "bedrock"
  | "fireworks"
  | "gemini"
  | "gemini-enterprise"
  | "grok-build"
  | "nebius"
  | "nvidia"
  | "openai"
  | "openai-chatgpt"
  | "openai-compatible"
  | "openrouter";

/**
 * How a provider authenticates. Providers default to `"api-key"` (a pasted
 * secret persisted to a `*_API_KEY` env var); `"oauth"` providers instead run a
 * browser login flow and persist short-lived access/refresh tokens;
 * `"cli-login"` providers use a local vendor CLI session (no OpenWiki secret).
 */
export type ProviderAuthMethod = "api-key" | "oauth" | "cli-login";

export type SelectableOpenWikiProvider = OpenWikiProvider;

export type ProviderModelOption = {
  id: string;
  label: string;
};

/**
 * Model options offered by OpenAI. Shared by the `openai` (API key) and
 * `openai-chatgpt` (OAuth login) providers so the two always expose an
 * identical model list.
 */
const OPENAI_MODEL_OPTIONS: ProviderModelOption[] = [
  { id: "gpt-5.6-terra", label: "5.6 Terra" },
  { id: "gpt-5.6-luna", label: "5.6 Luna" },
  { id: "gpt-5.6-sol", label: "5.6 Sol" },
  { id: "gpt-5.5", label: "5.5" },
  { id: "gpt-5.4-mini", label: "5.4 mini" },
];

/**
 * Google's own Gemini models. Offered by the `gemini` (AI Studio) provider and,
 * on Gemini Enterprise (Vertex AI), served over the native `generateContent`
 * surface. The `gemini-enterprise` provider additionally reaches Claude and
 * partner/open-weight Model Garden models by pasting those model IDs directly.
 */
const GEMINI_MODELS: ProviderModelOption[] = [
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro" },
  { id: "gemini-3-flash", label: "Gemini 3 Flash" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" },
];

export type ApiProviderConfig = {
  kind: "api";
  /**
   * Environment variable holding the provider's API key. Absent when the
   * provider authenticates without an API key (e.g. Google Application
   * Default Credentials for Vertex AI).
   */
  apiKeyEnvKey?: string;
  /**
   * Authentication method for the provider. Omitted entries are implicitly
   * {@link ProviderAuthMethod} `"api-key"`. `"oauth"` providers replace the
   * pasted-key setup step with a browser login and store tokens instead.
   */
  authMethod?: ProviderAuthMethod;
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
  /**
   * Environment variable holding the cloud project identifier required to
   * run the provider (e.g. a Google Cloud project ID).
   */
  projectEnvKey?: string;
  /**
   * Environment variable that overrides {@link ApiProviderConfig.defaultLocation}
   * with an alternative cloud location/region.
   */
  locationEnvKey?: string;
  defaultLocation?: string;
  label: string;
  modelOptions: ProviderModelOption[];
  /**
   * Environment variable holding a second required secret (e.g. an AWS secret
   * access key paired with {@link ApiProviderConfig.apiKeyEnvKey} as an access key
   * ID). Omitted for providers authenticated by a single API key.
   */
  secretKeyEnvKey?: string;
  /**
   * Environment variable holding the provider's region (e.g. an AWS region).
   * Only relevant when {@link ApiProviderConfig.requiresRegion} is true.
   */
  regionEnvKey?: string;
  /**
   * When true, the provider has no default region and requires one to be
   * supplied via {@link ApiProviderConfig.regionEnvKey}.
   */
  requiresRegion?: boolean;
};

/**
 * Subscription-authenticated local agent CLIs (for example Grok Build). These
 * providers have no API key; OpenWiki spawns the vendor binary and uses the
 * CLI's own login session.
 */
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

export type ProviderConfig = ApiProviderConfig | AgentCliProviderConfig;

export const SELECTABLE_OPENWIKI_PROVIDERS = [
  "openai",
  "openai-chatgpt",
  "anthropic",
  "grok-build",
  "gemini",
  "gemini-enterprise",
  "openrouter",
  "openai-compatible",
  "bedrock",
  "fireworks",
  "baseten",
  "nebius",
  "nvidia",
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
  bedrock: {
    kind: "api",
    apiKeyEnvKey: BEDROCK_AWS_ACCESS_KEY_ID_ENV_KEY,
    label: "AWS Bedrock",
    // Available model IDs are account- and region-specific (they depend on
    // which foundation models are enabled in Bedrock), so there is no safe
    // preset list here; paste the Bedrock model ID directly, for example
    // anthropic.claude-sonnet-5-20260101-v1:0.
    modelOptions: [],
    secretKeyEnvKey: BEDROCK_AWS_SECRET_ACCESS_KEY_ENV_KEY,
    regionEnvKey: BEDROCK_AWS_REGION_ENV_KEY,
    requiresRegion: true,
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
  "grok-build": {
    kind: "agent-cli",
    binaryEnvKey: GROK_BUILD_BINARY_ENV_KEY,
    defaultBinary: "grok",
    installHint:
      "Install the Grok Build CLI, then run `grok login` so OpenWiki can use your subscription session.",
    label: "Grok Build (subscription)",
    modelOptions: [
      { id: "grok-4.5", label: "Grok 4.5" },
      { id: "grok-composer-2.5-fast", label: "Composer 2.5 Fast" },
    ],
  },
  nebius: {
    kind: "api",
    apiKeyEnvKey: NEBIUS_API_KEY_ENV_KEY,
    baseURL: NEBIUS_BASE_URL,
    label: "Nebius Token Factory",
    modelOptions: [{ id: "moonshotai/Kimi-K2.6", label: "Kimi K2.6" }],
  },
  nvidia: {
    kind: "api",
    apiKeyEnvKey: NVIDIA_API_KEY_ENV_KEY,
    baseURL: "https://integrate.api.nvidia.com/v1",
    label: "NVIDIA NIM",
    modelOptions: [
      {
        id: "nvidia/nemotron-3-super-120b-a12b",
        label: "Nemotron 3 Super 120B A12B",
      },
      {
        id: "nvidia/nemotron-3-ultra-550b-a55b",
        label: "Nemotron 3 Ultra 550B A55B",
      },
      {
        id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
        label: "Nemotron 3 Nano Omni 30B A3B",
      },
      { id: "deepseek-ai/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
      { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B" },
      { id: "moonshotai/kimi-k2.6", label: "Kimi K2.6" },
    ],
  },
  openai: {
    kind: "api",
    apiKeyEnvKey: OPENAI_API_KEY_ENV_KEY,
    baseUrlEnvKey: OPENAI_BASE_URL_ENV_KEY,
    label: "OpenAI",
    modelOptions: OPENAI_MODEL_OPTIONS,
  },
  "openai-chatgpt": {
    kind: "api",
    apiKeyEnvKey: OPENAI_CHATGPT_ACCESS_TOKEN_ENV_KEY,
    authMethod: "oauth",
    label: "OpenAI (ChatGPT login)",
    modelOptions: OPENAI_MODEL_OPTIONS,
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
  gemini: {
    kind: "api",
    apiKeyEnvKey: GEMINI_API_KEY_ENV_KEY,
    label: "Gemini (AI Studio)",
    modelOptions: GEMINI_MODELS,
  },
  "gemini-enterprise": {
    kind: "api",
    // Keyless: authenticated by Google Application Default Credentials against a
    // Cloud project + location, not an API key. Routes by model family to the
    // right Model Garden surface (Gemini, Claude, or OpenAI-compatible MaaS);
    // see createGeminiEnterpriseModel / resolveVertexSurface.
    projectEnvKey: GOOGLE_CLOUD_PROJECT_ENV_KEY,
    locationEnvKey: GOOGLE_CLOUD_LOCATION_ENV_KEY,
    defaultLocation: DEFAULT_VERTEX_LOCATION,
    label: "Gemini Enterprise (Vertex AI)",
    // Google's own Gemini models plus the curated Claude Model Garden IDs. Other
    // partner/open-weight (MaaS) models are reached by pasting their model ID.
    modelOptions: [
      ...GEMINI_MODELS,
      { id: "claude-haiku-4-5@20251001", label: "Claude Haiku" },
      { id: "claude-sonnet-5", label: "Claude Sonnet" },
      { id: "claude-opus-4-8", label: "Claude Opus" },
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
  PROVIDER_CONFIGS[DEFAULT_PROVIDER].modelOptions[0]?.id ?? "gpt-5.6-terra";

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

export function getProviderApiKeyEnvKey(
  provider: OpenWikiProvider,
): string | undefined {
  return getApiProviderConfig(provider).apiKeyEnvKey;
}

export function getProviderAuthMethod(
  provider: OpenWikiProvider,
): ProviderAuthMethod {
  const config = getProviderConfig(provider);

  if (config.kind === "agent-cli") {
    return "cli-login";
  }

  return config.authMethod ?? "api-key";
}

export function providerUsesOAuth(provider: OpenWikiProvider): boolean {
  return getProviderAuthMethod(provider) === "oauth";
}

export function providerRequiresApiKey(provider: OpenWikiProvider): boolean {
  const config = getProviderConfig(provider);

  return config.kind === "api" && config.apiKeyEnvKey !== undefined;
}

/**
 * Composes the in-session notice shown after switching providers. Agent CLI
 * providers have no API key, so their notice points at the local CLI login
 * instead of an API-key environment variable.
 */
export function formatProviderSwitchNotice(provider: OpenWikiProvider): string {
  const modelOptions = getProviderModelOptions(provider);
  const modelNotice =
    modelOptions.length > 0
      ? ` with model ${getDefaultModelId(provider)}`
      : ". Set a model with /model";
  const switched = `Provider switched to ${getProviderLabel(provider)}${modelNotice}.`;

  if (isAgentCliProvider(provider)) {
    return `${switched} Runs use the local agent CLI login.`;
  }

  const apiKeyEnvKey = getProviderApiKeyEnvKey(provider);

  if (apiKeyEnvKey) {
    return `${switched} Ensure ${apiKeyEnvKey} is set.`;
  }

  const projectEnvKey = getProviderProjectEnvKey(provider);
  const hint = getProviderCredentialHint(provider);
  const requirement = projectEnvKey
    ? `Ensure ${projectEnvKey} is set.${hint ? ` ${hint}` : ""}`
    : (hint ?? "");

  return requirement ? `${switched} ${requirement}` : switched;
}

export function getProviderProjectEnvKey(
  provider: OpenWikiProvider,
): string | undefined {
  const config = getProviderConfig(provider);

  return config.kind === "api" ? config.projectEnvKey : undefined;
}

export function getProviderLocationEnvKey(
  provider: OpenWikiProvider,
): string | undefined {
  const config = getProviderConfig(provider);

  return config.kind === "api" ? config.locationEnvKey : undefined;
}

/**
 * Returns the first required-but-unset environment variable for a provider
 * (its API key, or its cloud project for providers that authenticate without
 * one), or `null` when the provider has everything it needs to run. Base URL
 * requirements are checked separately via {@link providerRequiresBaseUrl}.
 * Agent CLI providers never report a missing key here — auth is the vendor CLI
 * login, which is checked when the binary is spawned.
 */
export function getMissingProviderEnvKey(
  provider: OpenWikiProvider,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const config = getProviderConfig(provider);

  if (config.kind === "agent-cli") {
    return null;
  }

  if (config.apiKeyEnvKey && !env[config.apiKeyEnvKey]) {
    return config.apiKeyEnvKey;
  }

  if (config.projectEnvKey && !env[config.projectEnvKey]) {
    return config.projectEnvKey;
  }

  return null;
}

/**
 * Resolves the cloud location for a provider, preferring the provider's
 * configured environment variable over its built-in default. Returns
 * `undefined` for providers without a location concept.
 */
export function resolveProviderLocation(
  provider: OpenWikiProvider,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const config = getProviderConfig(provider);

  if (config.kind !== "api") {
    return undefined;
  }

  const override = config.locationEnvKey
    ? env[config.locationEnvKey]
    : undefined;
  const trimmedOverride = override?.trim();

  if (trimmedOverride) {
    return trimmedOverride;
  }

  return config.defaultLocation;
}

/**
 * A human-readable hint for providers whose credentials live outside the
 * OpenWiki env file, appended to missing-credential error messages.
 */
export function getProviderCredentialHint(
  provider: OpenWikiProvider,
): string | null {
  if (provider === "gemini-enterprise") {
    return (
      "Authenticate to Google Cloud with Application Default Credentials " +
      "(gcloud auth application-default login) or set " +
      `${GOOGLE_APPLICATION_CREDENTIALS_ENV_KEY} to a service account key file.`
    );
  }

  if (isAgentCliProvider(provider)) {
    return getAgentCliProviderConfig(provider).installHint;
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

export function getProviderSecretKeyEnvKey(
  provider: OpenWikiProvider,
): string | undefined {
  const config = getProviderConfig(provider);

  return config.kind === "api" ? config.secretKeyEnvKey : undefined;
}

export function providerRequiresSecretKey(provider: OpenWikiProvider): boolean {
  return getProviderSecretKeyEnvKey(provider) !== undefined;
}

export function getProviderRegionEnvKey(
  provider: OpenWikiProvider,
): string | undefined {
  const config = getProviderConfig(provider);

  return config.kind === "api" ? config.regionEnvKey : undefined;
}

export function providerRequiresRegion(provider: OpenWikiProvider): boolean {
  const config = getProviderConfig(provider);

  return config.kind === "api" && config.requiresRegion === true;
}

/**
 * Resolves the configured region for a provider from its region environment
 * variable. Returns `undefined` when unset, so callers fall back to the SDK's
 * own region resolution (e.g. `~/.aws/config`).
 */
export function resolveProviderRegion(
  provider: OpenWikiProvider,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const regionEnvKey = getProviderRegionEnvKey(provider);
  const region = regionEnvKey ? env[regionEnvKey]?.trim() : undefined;

  return region ? region : undefined;
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

export function getProviderBaseUrlWarnings(
  provider: OpenWikiProvider,
  value: string,
): string[] {
  if (!isValidBaseUrl(value)) {
    return ["invalid base URL"];
  }

  if (provider === "openai-compatible" && isChatCompletionsEndpointUrl(value)) {
    return ["use API root URL, not /chat/completions endpoint"];
  }

  return [];
}

export function isValidProviderBaseUrl(
  provider: OpenWikiProvider,
  value: string,
): boolean {
  return getProviderBaseUrlWarnings(provider, value).length === 0;
}

function isChatCompletionsEndpointUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    const normalizedPath = url.pathname.replace(/\/+$/u, "").toLowerCase();

    return normalizedPath.endsWith("/chat/completions");
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

// Returns the list of built-in providers whose known model options include the
// given model ID by exact match, excluding the provider passed in. Used to warn
// when a saved model plainly belongs to a different provider (e.g. an Anthropic
// model left over while the provider is now OpenAI). Exact matching avoids false
// positives from namespaced overlaps such as OpenRouter's "anthropic/claude-...".
// Returns an empty array for custom/unknown model IDs, so gateway and
// OpenAI-compatible model names are never flagged.
export function getProvidersForKnownModelId(
  modelId: string,
  excludeProvider: OpenWikiProvider,
): OpenWikiProvider[] {
  const normalized = normalizeModelId(modelId);
  const providers: OpenWikiProvider[] = [];

  for (const provider of Object.keys(PROVIDER_CONFIGS) as OpenWikiProvider[]) {
    if (provider === excludeProvider) {
      continue;
    }
    if (
      getProviderModelOptions(provider).some(
        (option) => option.id === normalized,
      )
    ) {
      providers.push(provider);
    }
  }

  return providers;
}

// True when the model ID is a known model of some other provider and is NOT a
// known model of the configured provider — a clear provider/model mismatch.
export function isModelIdForOtherProvider(
  modelId: string,
  provider: OpenWikiProvider,
): boolean {
  const normalized = normalizeModelId(modelId);
  const isKnownForProvider = getProviderModelOptions(provider).some(
    (option) => option.id === normalized,
  );

  if (isKnownForProvider) {
    return false;
  }

  return getProvidersForKnownModelId(normalized, provider).length > 0;
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
    (env[OPENAI_API_KEY_ENV_KEY]
      ? "openai"
      : env[OPENAI_COMPATIBLE_API_KEY_ENV_KEY]
        ? "openai-compatible"
        : env[OPENROUTER_API_KEY_ENV_KEY]
          ? "openrouter"
          : env[ANTHROPIC_API_KEY_ENV_KEY]
            ? "anthropic"
            : env[BASETEN_API_KEY_ENV_KEY]
              ? "baseten"
              : env[FIREWORKS_API_KEY_ENV_KEY]
                ? "fireworks"
                : env[NEBIUS_API_KEY_ENV_KEY]
                  ? "nebius"
                  : env[NVIDIA_API_KEY_ENV_KEY]
                    ? "nvidia"
                    : env[BEDROCK_AWS_ACCESS_KEY_ID_ENV_KEY]
                      ? "bedrock"
                      : DEFAULT_PROVIDER)
  );
}

export function resolveProviderRetryAttempts(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const rawRetryAttempts = env[OPENWIKI_PROVIDER_RETRY_ATTEMPTS_ENV_KEY];

  if (rawRetryAttempts === undefined) {
    return DEFAULT_PROVIDER_RETRY_ATTEMPTS;
  }

  const retryAttempts = rawRetryAttempts.trim();

  if (!/^[1-9]\d*$/u.test(retryAttempts)) {
    throw new Error(
      `Invalid ${OPENWIKI_PROVIDER_RETRY_ATTEMPTS_ENV_KEY}. Expected a positive integer.`,
    );
  }

  const parsedRetryAttempts = Number(retryAttempts);

  if (!Number.isSafeInteger(parsedRetryAttempts)) {
    throw new Error(
      `Invalid ${OPENWIKI_PROVIDER_RETRY_ATTEMPTS_ENV_KEY}. Expected a positive integer.`,
    );
  }

  return parsedRetryAttempts;
}

export function resolveOpenRouterProviderOnly(
  env: NodeJS.ProcessEnv = process.env,
): string[] | undefined {
  const rawProviderOnly = env[OPENWIKI_OPENROUTER_PROVIDER_ONLY_ENV_KEY];

  if (rawProviderOnly === undefined) {
    return undefined;
  }

  const providers = rawProviderOnly
    .split(",")
    .map((provider) => provider.trim())
    .filter((provider) => provider.length > 0);

  return providers.length > 0 ? providers : undefined;
}

export function normalizeModelId(value: string): string {
  return value.trim();
}

export function isValidModelId(value: string): boolean {
  const modelId = normalizeModelId(value);

  return (
    modelId.length > 0 &&
    modelId.length <= 120 &&
    // Leading @ for Cloudflare Workers AI ids (@cf/...); interior @ for
    // Vertex AI @-versioned ids (e.g. claude-sonnet-4-5@20250929).
    /^[@A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u.test(modelId) &&
    !modelId.includes("://")
  );
}

export const OPENWIKI_VERSION = "0.2.0";
