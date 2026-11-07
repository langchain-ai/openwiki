import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const chatOpenAIArgs: Array<Record<string, unknown>> = [];
const chatAnthropicArgs: Array<[string, Record<string, unknown>]> = [];

vi.mock("@langchain/openai", () => ({
  ChatOpenAI: class {
    constructor(options: Record<string, unknown>) {
      chatOpenAIArgs.push(options);
    }
  },
}));

vi.mock("@langchain/anthropic", () => ({
  ChatAnthropic: class {
    constructor(_model: string, options: Record<string, unknown>) {
      chatAnthropicArgs.push([_model, options]);
    }
  },
}));

const { createModel } = await import("../../src/agent/index.ts");
const { OPENWIKI_CLIENT_TIMEOUT_MS_ENV_KEY } =
  await import("../../src/config/constants.ts");

describe("createModel client timeout wiring", () => {
  let savedClientTimeout: string | undefined;

  beforeEach(() => {
    savedClientTimeout = process.env[OPENWIKI_CLIENT_TIMEOUT_MS_ENV_KEY];
    delete process.env[OPENWIKI_CLIENT_TIMEOUT_MS_ENV_KEY];
    chatOpenAIArgs.length = 0;
    chatAnthropicArgs.length = 0;
  });

  afterEach(() => {
    if (savedClientTimeout === undefined) {
      delete process.env[OPENWIKI_CLIENT_TIMEOUT_MS_ENV_KEY];
    } else {
      process.env[OPENWIKI_CLIENT_TIMEOUT_MS_ENV_KEY] = savedClientTimeout;
    }
  });

  test("does not set timeout when OPENWIKI_CLIENT_TIMEOUT_MS is unset and no argument is given", () => {
    createModel("openai-compatible", "my-model", 0);
    expect(chatOpenAIArgs).toHaveLength(1);
    expect(chatOpenAIArgs[0]).not.toHaveProperty("timeout");
  });

  test("passes timeout to ChatOpenAI when OPENWIKI_CLIENT_TIMEOUT_MS is configured in env", () => {
    process.env[OPENWIKI_CLIENT_TIMEOUT_MS_ENV_KEY] = "1800000";
    createModel("openai-compatible", "my-model", 0);
    expect(chatOpenAIArgs).toHaveLength(1);
    expect(chatOpenAIArgs[0]?.timeout).toBe(1800000);
  });

  test("passes timeout to ChatOpenAI when clientTimeout argument is provided explicitly", () => {
    createModel(
      "openai-compatible",
      "my-model",
      0,
      undefined,
      undefined,
      2400000,
    );
    expect(chatOpenAIArgs).toHaveLength(1);
    expect(chatOpenAIArgs[0]?.timeout).toBe(2400000);
  });

  test("explicit clientTimeout argument overrides env", () => {
    process.env[OPENWIKI_CLIENT_TIMEOUT_MS_ENV_KEY] = "1800000";
    createModel(
      "openai-compatible",
      "my-model",
      0,
      undefined,
      undefined,
      3000000,
    );
    expect(chatOpenAIArgs).toHaveLength(1);
    expect(chatOpenAIArgs[0]?.timeout).toBe(3000000);
  });

  test("passes timeout to direct OpenAI provider", () => {
    process.env[OPENWIKI_CLIENT_TIMEOUT_MS_ENV_KEY] = "1200000";
    createModel("openai", "gpt-5.5", 0);
    expect(chatOpenAIArgs).toHaveLength(1);
    expect(chatOpenAIArgs[0]?.timeout).toBe(1200000);
  });

  test("passes clientOptions.timeout to Anthropic provider", () => {
    process.env[OPENWIKI_CLIENT_TIMEOUT_MS_ENV_KEY] = "900000";
    createModel("anthropic", "claude-sonnet-5", 0);
    expect(chatAnthropicArgs).toHaveLength(1);
    expect(
      (chatAnthropicArgs[0]?.[1]?.clientOptions as Record<string, unknown>)
        ?.timeout,
    ).toBe(900000);
  });
});
