import {
  getProviderApiKeyEnvKey,
  getProviderBaseUrlEnvKey,
  isAgentCliProvider,
  normalizeProvider,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
  providerRequiresBaseUrl,
  resolveConfiguredProvider,
  type OpenWikiProvider,
} from "./constants.js";

export type PromptStep =
  | "agent-check"
  | "api-key"
  | "base-url"
  | "langsmith"
  | "model"
  | "provider";

export function hasValidConfiguredProvider(): boolean {
  return normalizeProvider(process.env[OPENWIKI_PROVIDER_ENV_KEY]) !== null;
}

export function needsCredentialSetup(
  modelIdOverride: string | null = null,
): boolean {
  const provider = resolveConfiguredProvider();

  if (isAgentCliProvider(provider)) {
    return !hasValidConfiguredProvider() || needsModelStep(modelIdOverride);
  }

  return (
    !hasValidConfiguredProvider() ||
    !process.env[getProviderApiKeyEnvKey(provider)] ||
    needsBaseUrlStep(provider) ||
    needsModelStep(modelIdOverride) ||
    process.env.LANGSMITH_API_KEY === undefined
  );
}

export function needsBaseUrlStep(provider: OpenWikiProvider): boolean {
  if (!providerRequiresBaseUrl(provider)) {
    return false;
  }

  return !isBaseUrlConfigured(provider);
}

export function isBaseUrlConfigured(provider: OpenWikiProvider): boolean {
  const baseUrlEnvKey = getProviderBaseUrlEnvKey(provider);

  return baseUrlEnvKey ? Boolean(process.env[baseUrlEnvKey]) : false;
}

function needsModelStep(modelIdOverride: string | null): boolean {
  return (
    modelIdOverride === null &&
    process.env[OPENWIKI_MODEL_ID_ENV_KEY] === undefined
  );
}

export function getInitialStep(
  modelIdOverride: string | null,
  provider: OpenWikiProvider,
): PromptStep | null {
  if (!hasValidConfiguredProvider()) {
    return "provider";
  }

  if (isAgentCliProvider(provider)) {
    return needsModelStep(modelIdOverride) ? "agent-check" : null;
  }

  if (!process.env[getProviderApiKeyEnvKey(provider)]) {
    return "api-key";
  }

  if (needsBaseUrlStep(provider)) {
    return "base-url";
  }

  if (needsModelStep(modelIdOverride)) {
    return "model";
  }

  if (process.env.LANGSMITH_API_KEY === undefined) {
    return "langsmith";
  }

  return null;
}

export function getNextStepAfterProvider(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
): PromptStep | null {
  if (isAgentCliProvider(provider)) {
    return "agent-check";
  }

  if (!process.env[getProviderApiKeyEnvKey(provider)]) {
    return "api-key";
  }

  return getNextStepAfterApiKey(provider, modelIdOverride);
}

export function getNextStepAfterAgentCheck(
  _provider: OpenWikiProvider,
  modelIdOverride: string | null,
): PromptStep | null {
  return needsModelStep(modelIdOverride) ? "model" : null;
}

export function getNextStepAfterApiKey(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
): PromptStep | null {
  if (needsBaseUrlStep(provider)) {
    return "base-url";
  }

  return getNextStepAfterBaseUrl(provider, modelIdOverride);
}

export function getNextStepAfterBaseUrl(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
): PromptStep | null {
  if (needsModelStep(modelIdOverride)) {
    return "model";
  }

  if (process.env.LANGSMITH_API_KEY === undefined) {
    return "langsmith";
  }

  return null;
}

export function getNextStepAfterModel(
  provider: OpenWikiProvider,
): PromptStep | null {
  if (isAgentCliProvider(provider)) {
    return null;
  }

  return process.env.LANGSMITH_API_KEY === undefined ? "langsmith" : null;
}
