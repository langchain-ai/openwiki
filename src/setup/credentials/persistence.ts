import { codexTokensToEnv } from "../../agent/openai-chatgpt-oauth.js";
import {
  getProviderApiKeyEnvKey,
  getProviderBaseUrlEnvKey,
  getProviderLocationEnvKey,
  getProviderProjectEnvKey,
  getProviderRegionEnvKey,
  getProviderSecretKeyEnvKey,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
  OPENWIKI_REASONING_EFFORT_ENV_KEY,
} from "../../config/constants.js";
import type { CompleteSetupOptions } from "./types.js";

/**
 * Build the `~/.openwiki/.env` update map from the values the wizard collected.
 *
 * Pure: it computes which keys to write and their values, but performs no IO and
 * mutates nothing. The caller resolves the oauth-token fallback and persists the
 * result (via `saveOpenWikiEnv`), which is what owns the file permissions. A key
 * is included only when the wizard collected a value for it, so untouched
 * settings are left as-is. The provider key is written only when it actually
 * changes, so a re-run that keeps the same provider does not churn the file.
 *
 * @param options - the credential/config values collected this session.
 *
 * @param env - the environment to compare against for the provider-changed
 * check; injected so tests can pass a fabricated `NodeJS.ProcessEnv` instead of
 * reading the real one.
 */
export function buildCredentialEnvUpdates(
  options: CompleteSetupOptions,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const {
    nextApiKey,
    nextBaseUrl,
    nextGcpLocation,
    nextGcpProject,
    nextLangSmithKey,
    nextModelId,
    nextReasoningEffort = null,
    nextOAuthTokens,
    nextProvider,
    nextRegion,
    nextSecretKey,
  } = options;

  const updates: Record<string, string> = {};

  if (env[OPENWIKI_PROVIDER_ENV_KEY] !== nextProvider) {
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

  if (nextReasoningEffort !== null) {
    updates[OPENWIKI_REASONING_EFFORT_ENV_KEY] = nextReasoningEffort;
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

  return updates;
}
