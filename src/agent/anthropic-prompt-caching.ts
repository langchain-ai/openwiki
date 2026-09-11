import { ChatAnthropic } from "@langchain/anthropic";
import { createMiddleware } from "langchain";
import { resolveAnthropicPromptCachingEnabled } from "../config/constants.js";

// A single top-level cache_control breakpoint. @langchain/anthropic forwards
// this as Anthropic's top-level `cache_control` request parameter, which
// automatically applies a cache breakpoint to the last cacheable block in the
// request (system prompt + tool definitions on turn one) and advances it as
// the conversation grows on later turns. This is the mechanism the library
// itself recommends for multi-turn agent loops in preference to placing
// cache_control on individual content blocks by hand.
const ANTHROPIC_TOP_LEVEL_CACHE_CONTROL = { type: "ephemeral" } as const;

/**
 * Middleware that opts Anthropic requests into prompt caching.
 *
 * OpenWiki's agent loops (chat turns, and the repository planner/page
 * workers) resend an unchanging system prompt and tool schema set on every
 * turn. Without a cache breakpoint, Anthropic bills that stable prefix at
 * full input price on every turn instead of the ~10% cache-read rate
 * (issue #696). This middleware is safe to add to every agent's middleware
 * list unconditionally: it only touches the request when the resolved model
 * for that step is a `ChatAnthropic` instance, so chat/OpenAI/Gemini/etc.
 * provider runs are untouched, and it can be disabled entirely with
 * `OPENWIKI_ANTHROPIC_PROMPT_CACHING=false`.
 *
 * @returns Provider-scoped `wrapModelCall` middleware.
 */
export function createAnthropicPromptCachingMiddleware() {
  return createMiddleware({
    name: "OpenWikiAnthropicPromptCaching",
    wrapModelCall: (request, handler) => {
      if (
        !(request.model instanceof ChatAnthropic) ||
        !resolveAnthropicPromptCachingEnabled()
      ) {
        return handler(request);
      }

      return handler({
        ...request,
        modelSettings: {
          ...request.modelSettings,
          cache_control: ANTHROPIC_TOP_LEVEL_CACHE_CONTROL,
        },
      });
    },
  });
}
