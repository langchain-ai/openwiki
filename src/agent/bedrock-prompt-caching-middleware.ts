import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createMiddleware } from "langchain";
import { resolveBedrockCacheTtl } from "../config/constants.js";

// LangChain's registered name for the Bedrock Converse chat model, returned by
// `getName()`. Matching the name rather than the class keeps the check working
// when the model instance comes from a different copy of `@langchain/aws` than
// this module imports.
const BEDROCK_CONVERSE_MODEL_NAME = "ChatBedrockConverse";

/**
 * Creates middleware that asks Bedrock to cache each request's stable prefix,
 * or nothing at all when the run cannot use it.
 *
 * `ChatBedrockConverse` translates `cache_control` into Converse `cachePoint`
 * blocks after the system prompt, the tool definitions, and the final message.
 * Without it no cache point is emitted, so every call reprocesses the whole
 * prefix at full input price.
 *
 * Nothing is installed for a model from another provider, which also means
 * `OPENWIKI_BEDROCK_CACHE_TTL` is never read on a run that could not honor it:
 * a stale or malformed value only fails the provider it configures.
 *
 * LangChain's own `bedrockPromptCachingMiddleware` is not used because it
 * decides cache capability by substring-matching the model id against
 * `anthropic.claude` and `amazon.nova`. An application inference profile ARN
 * names a profile rather than a family, so it matches neither and silently
 * loses caching, even though Bedrock caches such profiles exactly as it caches
 * system profiles.
 *
 * @param model - Model the agent being built will call.
 * @returns Middleware that sets `cache_control`, or `undefined` when the model
 * is not a Bedrock Converse model or caching is turned off.
 */
export function createOptionalBedrockPromptCachingMiddleware(
  model: BaseChatModel,
) {
  if (!isBedrockConverseModel(model)) {
    return undefined;
  }

  const ttl = resolveBedrockCacheTtl();

  if (!ttl) {
    return undefined;
  }

  return createMiddleware({
    name: "OpenWikiBedrockPromptCaching",
    wrapModelCall: (request, handler) =>
      isBedrockConverseModel(request.model)
        ? handler({
            ...request,
            modelSettings: {
              ...request.modelSettings,
              cache_control: { type: "ephemeral", ttl },
            },
          })
        : handler(request),
  });
}

function isBedrockConverseModel(model: unknown): boolean {
  const getName = (model as { getName?: unknown } | null)?.getName;

  return (
    typeof getName === "function" &&
    getName.call(model) === BEDROCK_CONVERSE_MODEL_NAME
  );
}
