export const OPEN_WIKI_DIR = "openwiki";
export const UPDATE_METADATA_PATH = `${OPEN_WIKI_DIR}/.last-update.json`;
export const BASETEN_API_KEY_ENV_KEY = "BASETEN_API_KEY";
export const FIREWORKS_API_KEY_ENV_KEY = "FIREWORKS_API_KEY";
export const OPENAI_API_KEY_ENV_KEY = "OPENAI_API_KEY";
export const ANTHROPIC_API_KEY_ENV_KEY = "ANTHROPIC_API_KEY";
export const OPENROUTER_API_KEY_ENV_KEY = "OPENROUTER_API_KEY";
export const OPENWIKI_PROVIDER_ENV_KEY = "OPENWIKI_PROVIDER";
export const OPENWIKI_MODEL_ID_ENV_KEY = "OPENWIKI_MODEL_ID";
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
export const OPENWIKI_LANGSMITH_API_KEY_ENV_KEY = "OPENWIKI_LANGSMITH_API_KEY";
export const OPENWIKI_DIAGRAMS_ENV_KEY = "OPENWIKI_DIAGRAMS";
export const DEFAULT_PROVIDER = "openai";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export type OpenWikiProvider =
  "anthropic" | "baseten" | "fireworks" | "openai" | "openrouter";

export type SelectableOpenWikiProvider = OpenWikiProvider;

export type ProviderModelOption = {
  id: string;
  label: string;
};

type ProviderConfig = {
  apiKeyEnvKey: string;
  baseURL?: string;
  label: string;
  modelOptions: ProviderModelOption[];
};

export const SELECTABLE_OPENWIKI_PROVIDERS = [
  "openai",
  "openrouter",
  "baseten",
  "fireworks",
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
      { id: "gpt-5.5", label: "5.5" },
      { id: "gpt-5.4-mini", label: "5.4 mini" },
    ],
  },
  anthropic: {
    apiKeyEnvKey: ANTHROPIC_API_KEY_ENV_KEY,
    label: "Anthropic",
    modelOptions: [
      { id: "claude-haiku-4-5", label: "Haiku" },
      { id: "claude-sonnet-5", label: "Sonnet" },
      { id: "claude-opus-4.8", label: "Opus" },
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
      { id: "anthropic/claude-opus-4.8", label: "Claude Opus" },
      { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet" },
      { id: "openai/gpt-5.4-mini", label: "GPT 5.4 mini" },
      { id: "openai/gpt-5.5", label: "GPT 5.5" },
    ],
  },
};

export const DEFAULT_MODEL_ID =
  PROVIDER_CONFIGS[DEFAULT_PROVIDER].modelOptions[0]?.id ?? "gpt-5.5";

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

export function getProviderApiKeyEnvKey(provider: OpenWikiProvider): string {
  return getProviderConfig(provider).apiKeyEnvKey;
}

export function getProviderModelOptions(
  provider: OpenWikiProvider,
): ProviderModelOption[] {
  return getProviderConfig(provider).modelOptions;
}

export function getDefaultModelId(provider: OpenWikiProvider): string {
  return getProviderModelOptions(provider)[0]?.id ?? DEFAULT_MODEL_ID;
}

export type DiagramFormat = "mermaid" | null;

export function resolveDiagramFormat(
  env: NodeJS.ProcessEnv = process.env,
): DiagramFormat {
  const value = env[OPENWIKI_DIAGRAMS_ENV_KEY];

  if (value === undefined || value === null) {
    return null;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "mermaid") {
    return "mermaid";
  }

  return null;
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
      : env[OPENROUTER_API_KEY_ENV_KEY]
        ? "openrouter"
        : env[ANTHROPIC_API_KEY_ENV_KEY]
          ? "anthropic"
          : env[BASETEN_API_KEY_ENV_KEY]
            ? "baseten"
            : env[FIREWORKS_API_KEY_ENV_KEY]
              ? "fireworks"
              : DEFAULT_PROVIDER)
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

export const OPENWIKI_VERSION = "0.1.0";
