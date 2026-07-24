import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Capture the options each Chat* constructor receives so we can assert that
// provider runtime options are wired through to every Gemini surface. These
// fields are not consistently readable on constructed instances, so we mock
// the constructors and inspect their args.
const chatGoogleArgs: Array<Record<string, unknown>> = [];
const chatAnthropicArgs: Array<[string, Record<string, unknown>]> = [];
const chatOpenAIArgs: Array<Record<string, unknown>> = [];
const chatOpenRouterArgs: Array<Record<string, unknown>> = [];

vi.mock("@langchain/google/node", () => ({
  ChatGoogle: class {
    constructor(options: Record<string, unknown>) {
      chatGoogleArgs.push(options);
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

vi.mock("@langchain/openai", () => ({
  ChatOpenAI: class {
    constructor(options: Record<string, unknown>) {
      chatOpenAIArgs.push(options);
    }
  },
}));

vi.mock("@langchain/openrouter", () => ({
  ChatOpenRouter: class {
    constructor(options: Record<string, unknown>) {
      chatOpenRouterArgs.push(options);
    }
  },
}));

// Imported after vi.mock so the mocked constructors are in effect.
const { createModel } = await import("../src/agent/index.ts");

const PROJECT_KEY = "GOOGLE_CLOUD_PROJECT";
const GEMINI_KEY = "GEMINI_API_KEY";
const CHATGPT_ENV_KEYS = [
  "OPENAI_CHATGPT_ACCESS_TOKEN",
  "OPENAI_CHATGPT_REFRESH_TOKEN",
  "OPENAI_CHATGPT_ACCOUNT_ID",
] as const;

describe("createModel wires runtime options into provider clients", () => {
  let savedProject: string | undefined;
  let savedGeminiKey: string | undefined;

  beforeEach(() => {
    savedProject = process.env[PROJECT_KEY];
    savedGeminiKey = process.env[GEMINI_KEY];
    process.env[PROJECT_KEY] = "test-project";
    process.env[GEMINI_KEY] = "test-gemini-key";
    chatGoogleArgs.length = 0;
    chatAnthropicArgs.length = 0;
    chatOpenAIArgs.length = 0;
    chatOpenRouterArgs.length = 0;
  });

  afterEach(() => {
    restoreEnv(PROJECT_KEY, savedProject);
    restoreEnv(GEMINI_KEY, savedGeminiKey);
  });

  test("gemini (AI Studio) passes runtime options and the API key to ChatGoogle", () => {
    createModel("gemini", "gemini-3.1-flash-lite", 5, 8192);

    expect(chatGoogleArgs).toHaveLength(1);
    expect(chatGoogleArgs[0]?.maxRetries).toBe(5);
    expect(chatGoogleArgs[0]?.maxOutputTokens).toBe(8192);
    // The API key is not a readable property on the built instance, so assert it
    // reaches the constructor here rather than in create-model.test.ts.
    expect(chatGoogleArgs[0]?.apiKey).toBe("test-gemini-key");
  });

  test("propagates maxRetries: 0 (not coerced to a default)", () => {
    createModel("gemini", "gemini-3.1-pro", 0);

    expect(chatGoogleArgs).toHaveLength(1);
    expect(chatGoogleArgs[0]?.maxRetries).toBe(0);
    expect(chatGoogleArgs[0]).not.toHaveProperty("maxOutputTokens");
  });

  test("gemini-enterprise Gemini surface passes runtime options to ChatGoogle", () => {
    createModel("gemini-enterprise", "gemini-3.1-pro", 4, 8192);

    expect(chatGoogleArgs).toHaveLength(1);
    expect(chatGoogleArgs[0]?.maxRetries).toBe(4);
    expect(chatGoogleArgs[0]?.maxOutputTokens).toBe(8192);
  });

  test("gemini-enterprise Claude surface passes runtime options to ChatAnthropic", () => {
    createModel(
      "gemini-enterprise",
      "publishers/anthropic/models/claude-sonnet-4-5@20250929",
      3,
      8192,
    );

    expect(chatAnthropicArgs).toHaveLength(1);
    expect(chatAnthropicArgs[0]?.[1].maxRetries).toBe(3);
    expect(chatAnthropicArgs[0]?.[1].maxTokens).toBe(8192);
  });

  test("gemini-enterprise MaaS surface passes runtime options to ChatOpenAI", () => {
    createModel(
      "gemini-enterprise",
      "publishers/meta/models/llama-3.3-70b-instruct-maas",
      2,
      8192,
    );

    expect(chatOpenAIArgs).toHaveLength(1);
    expect(chatOpenAIArgs[0]?.maxRetries).toBe(2);
    expect(chatOpenAIArgs[0]?.maxTokens).toBe(8192);
  });

  test("passes maxTokens to direct non-Google clients", () => {
    createModel("anthropic", "claude-sonnet-4-5", 3, 8192);
    createModel("openai", "gpt-5.6-terra", 3, 8192);
    createModel("openai-compatible", "custom-model", 3, 8192);
    createModel("openrouter", "anthropic/claude-sonnet-4.5", 3, 8192);

    expect(chatAnthropicArgs[0]?.[1].maxTokens).toBe(8192);
    expect(chatOpenAIArgs.map((options) => options.maxTokens)).toEqual([
      8192, 8192,
    ]);
    expect(chatOpenRouterArgs[0]?.maxTokens).toBe(8192);
  });

  test("passes maxTokens to the ChatGPT Responses client", () => {
    for (const key of CHATGPT_ENV_KEYS) {
      vi.stubEnv(key, `test-${key.toLowerCase()}`);
    }

    try {
      createModel("openai-chatgpt", "gpt-5.6-terra", 3, 8192);
      expect(chatOpenAIArgs[0]?.maxTokens).toBe(8192);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
