import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { createAnthropicPromptCachingMiddleware } from "../../src/agent/anthropic-prompt-caching.ts";

// Constructing these chat models makes no network calls (auth/clients
// resolve lazily on first request), matching the pattern used throughout
// test/agent/create-model.test.ts.

const TOGGLE_KEY = "OPENWIKI_ANTHROPIC_PROMPT_CACHING";

function fakeRequest(model: unknown) {
  return {
    model,
    messages: [],
    systemPrompt: "",
    tools: [],
  } as never;
}

describe("createAnthropicPromptCachingMiddleware", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[TOGGLE_KEY];
    delete process.env[TOGGLE_KEY];
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env[TOGGLE_KEY];
    } else {
      process.env[TOGGLE_KEY] = saved;
    }
  });

  test("adds a top-level ephemeral cache_control breakpoint for a ChatAnthropic model", async () => {
    const middleware = createAnthropicPromptCachingMiddleware();
    const model = new ChatAnthropic({
      model: "claude-sonnet-5",
      apiKey: "test-key",
    });
    const request = fakeRequest(model);

    let seenRequest: unknown;
    await middleware.wrapModelCall?.(request, async (nextRequest) => {
      seenRequest = nextRequest;
      return { role: "ai", content: "" } as never;
    });

    expect(
      (seenRequest as { modelSettings?: Record<string, unknown> })
        .modelSettings,
    ).toMatchObject({
      cache_control: { type: "ephemeral" },
    });
  });

  test("leaves the request untouched for a non-Anthropic model", async () => {
    const middleware = createAnthropicPromptCachingMiddleware();
    const model = new ChatOpenAI({
      model: "gpt-5.6",
      apiKey: "test-key",
    });
    const request = fakeRequest(model);

    let seenRequest: unknown;
    await middleware.wrapModelCall?.(request, async (nextRequest) => {
      seenRequest = nextRequest;
      return { role: "ai", content: "" } as never;
    });

    expect(seenRequest).toBe(request);
  });

  test("honors OPENWIKI_ANTHROPIC_PROMPT_CACHING=false", async () => {
    process.env[TOGGLE_KEY] = "false";
    const middleware = createAnthropicPromptCachingMiddleware();
    const model = new ChatAnthropic({
      model: "claude-sonnet-5",
      apiKey: "test-key",
    });
    const request = fakeRequest(model);

    let seenRequest: unknown;
    await middleware.wrapModelCall?.(request, async (nextRequest) => {
      seenRequest = nextRequest;
      return { role: "ai", content: "" } as never;
    });

    expect(seenRequest).toBe(request);
  });
});
