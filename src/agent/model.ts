import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI, type ChatOpenAIFields } from "@langchain/openai";
import { ChatOpenRouter } from "@langchain/openrouter";
import {
  getProviderApiKeyEnvKey,
  getProviderConfig,
  OPENROUTER_API_KEY_ENV_KEY,
  OPENROUTER_BASE_URL,
  normalizeModelId,
  type OpenWikiProvider,
} from "../constants.js";
import { createModelRoute } from "./model-route.js";

export function shouldUseOpenAiResponsesApi(modelId: string): boolean {
  const normalized = normalizeModelId(modelId).toLowerCase();

  if (normalized.startsWith("gpt-5") && !normalized.startsWith("gpt-5-chat")) {
    return true;
  }

  return /^o\d/u.test(normalized);
}

export function buildChatOpenAIFields(
  provider: OpenWikiProvider,
  modelId: string,
  apiKey: string,
): ChatOpenAIFields {
  const providerConfig = getProviderConfig(provider);
  const useResponsesApi =
    provider === "openai" && shouldUseOpenAiResponsesApi(modelId);

  return {
    apiKey,
    configuration: providerConfig.baseURL
      ? {
          baseURL: providerConfig.baseURL,
        }
      : undefined,
    model: modelId,
    ...(useResponsesApi ? { useResponsesApi: true } : {}),
  };
}

export async function createModel(provider: OpenWikiProvider, modelId: string) {
  if (provider === "anthropic") {
    return new ChatAnthropic(modelId, {
      apiKey: process.env[getProviderApiKeyEnvKey(provider)],
    });
  }

  if (provider === "openrouter") {
    const models = createModelRoute(provider, modelId);

    return new ChatOpenRouter({
      apiKey: process.env[OPENROUTER_API_KEY_ENV_KEY],
      baseURL: OPENROUTER_BASE_URL,
      model: modelId,
      models,
      route: "fallback",
      siteName: "OpenWiki",
    });
  }

  return new ChatOpenAI(
    buildChatOpenAIFields(
      provider,
      modelId,
      process.env[getProviderApiKeyEnvKey(provider)] ?? "",
    ),
  );
}
