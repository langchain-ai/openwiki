import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Capture the options each Chat* constructor receives so we can assert that the
// provider retry count (OPENWIKI_PROVIDER_RETRY_ATTEMPTS -> maxRetries) is wired
// through to every Gemini surface. maxRetries is not a readable property on the
// constructed instances, so we mock the constructors and inspect their args.
const chatGoogleArgs: Array<Record<string, unknown>> = [];
const chatAnthropicArgs: Array<[string, Record<string, unknown>]> = [];
const chatOpenAIArgs: Array<Record<string, unknown>> = [];

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

// Imported after vi.mock so the mocked constructors are in effect.
const { createModel } = await import("../src/agent/index.ts");

const PROJECT_KEY = "GOOGLE_CLOUD_PROJECT";
const GEMINI_KEY = "GEMINI_API_KEY";

describe("createModel wires retry attempts into the Gemini providers", () => {
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
  });

  afterEach(() => {
    restoreEnv(PROJECT_KEY, savedProject);
    restoreEnv(GEMINI_KEY, savedGeminiKey);
  });

  test("gemini (AI Studio) passes maxRetries and the API key to ChatGoogle", () => {
    createModel("gemini", "gemini-3.1-flash-lite", 5);

    expect(chatGoogleArgs).toHaveLength(1);
    expect(chatGoogleArgs[0]?.maxRetries).toBe(5);
    // The API key is not a readable property on the built instance, so assert it
    // reaches the constructor here rather than in create-model.test.ts.
    expect(chatGoogleArgs[0]?.apiKey).toBe("test-gemini-key");
  });

  test("propagates maxRetries: 0 (not coerced to a default)", () => {
    createModel("gemini", "gemini-3.1-pro", 0);

    expect(chatGoogleArgs).toHaveLength(1);
    expect(chatGoogleArgs[0]?.maxRetries).toBe(0);
  });

  test("gemini-enterprise Gemini surface passes maxRetries to ChatGoogle", () => {
    createModel("gemini-enterprise", "gemini-3.1-pro", 4);

    expect(chatGoogleArgs).toHaveLength(1);
    expect(chatGoogleArgs[0]?.maxRetries).toBe(4);
  });

  test("gemini-enterprise Claude surface passes maxRetries to ChatAnthropic", () => {
    createModel(
      "gemini-enterprise",
      "publishers/anthropic/models/claude-sonnet-4-5@20250929",
      3,
    );

    expect(chatAnthropicArgs).toHaveLength(1);
    expect(chatAnthropicArgs[0]?.[1].maxRetries).toBe(3);
  });

  test("gemini-enterprise MaaS surface passes maxRetries to ChatOpenAI", () => {
    createModel(
      "gemini-enterprise",
      "publishers/meta/models/llama-3.3-70b-instruct-maas",
      2,
    );

    expect(chatOpenAIArgs).toHaveLength(1);
    expect(chatOpenAIArgs[0]?.maxRetries).toBe(2);
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
