import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogle } from "@langchain/google/node";
import { ChatOpenAI } from "@langchain/openai";
import { createModel } from "../../src/agent/index.ts";
import { XAI_API_BASE_URL } from "../../src/agent/xai-grok-oauth.ts";
import {
  XAI_GROK_ACCESS_TOKEN_ENV_KEY,
  XAI_GROK_REFRESH_TOKEN_ENV_KEY,
  XAI_GROK_EXPIRES_AT_ENV_KEY,
} from "../../src/config/constants.ts";

// Constructing a LangChain chat model makes no network calls (auth/clients
// resolve lazily on first request), so these assert the gemini-enterprise
// surface dispatch and the project-id guard without needing GCP credentials.

const PROJECT_KEY = "GOOGLE_CLOUD_PROJECT";
const LOCATION_KEY = "GOOGLE_CLOUD_LOCATION";
const GEMINI_KEY = "GEMINI_API_KEY";

function modelName(model: unknown): string | undefined {
  return (model as { model?: string }).model;
}

describe("createModel gemini-enterprise surface dispatch", () => {
  let savedProject: string | undefined;
  let savedLocation: string | undefined;

  beforeEach(() => {
    savedProject = process.env[PROJECT_KEY];
    savedLocation = process.env[LOCATION_KEY];
    process.env[PROJECT_KEY] = "test-project";
    process.env[LOCATION_KEY] = "us-central1";
  });

  afterEach(() => {
    restoreEnv(PROJECT_KEY, savedProject);
    restoreEnv(LOCATION_KEY, savedLocation);
  });

  test("routes Claude IDs to ChatAnthropic and strips the publisher path", () => {
    const model = createModel(
      "gemini-enterprise",
      "publishers/anthropic/models/claude-sonnet-4-5@20250929",
      0,
    );

    expect(model).toBeInstanceOf(ChatAnthropic);
    expect(modelName(model)).toBe("claude-sonnet-4-5@20250929");
  });

  test("routes MaaS IDs to ChatOpenAI and normalizes to publisher/model", () => {
    const model = createModel(
      "gemini-enterprise",
      "publishers/meta/models/llama-3.3-70b-instruct-maas",
      0,
    );

    expect(model).toBeInstanceOf(ChatOpenAI);
    expect(model).not.toBeInstanceOf(ChatGoogle);
    expect(modelName(model)).toBe("meta/llama-3.3-70b-instruct-maas");
  });

  test("routes Gemini IDs to ChatGoogle", () => {
    const model = createModel("gemini-enterprise", "gemini-3.1-pro", 0);

    expect(model).toBeInstanceOf(ChatGoogle);
    expect(modelName(model)).toBe("gemini-3.1-pro");
  });

  test("routes Gemma IDs to ChatGoogle (default surface)", () => {
    const model = createModel("gemini-enterprise", "gemma-3-27b-it", 0);

    expect(model).toBeInstanceOf(ChatGoogle);
    expect(modelName(model)).toBe("gemma-3-27b-it");
  });

  test("strips the publisher path on the Gemini surface", () => {
    const model = createModel(
      "gemini-enterprise",
      "publishers/google/models/gemini-3-pro",
      0,
    );

    expect(model).toBeInstanceOf(ChatGoogle);
    expect(modelName(model)).toBe("gemini-3-pro");
  });

  test("resolves the global endpoint for the MaaS surface when location is unset", () => {
    delete process.env[LOCATION_KEY];

    const model = createModel(
      "gemini-enterprise",
      "publishers/meta/models/llama-3.3-70b-instruct-maas",
      0,
    );

    // The global endpoint uses the unprefixed host (not global-aiplatform…).
    const baseURL = (model as { clientConfig?: { baseURL?: string } })
      .clientConfig?.baseURL;
    expect(baseURL).toBe(
      "https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/endpoints/openapi",
    );
  });

  test("throws a clear error when the project ID is missing", () => {
    delete process.env[PROJECT_KEY];

    expect(() => createModel("gemini-enterprise", "gemini-3.1-pro", 0)).toThrow(
      /GOOGLE_CLOUD_PROJECT is required/u,
    );
  });
});

describe("createModel gemini (AI Studio)", () => {
  let savedGeminiKey: string | undefined;

  beforeEach(() => {
    savedGeminiKey = process.env[GEMINI_KEY];
    process.env[GEMINI_KEY] = "test-gemini-key";
  });

  afterEach(() => {
    restoreEnv(GEMINI_KEY, savedGeminiKey);
  });

  test("builds a ChatGoogle AI Studio client with v0 output pinned", () => {
    const model = createModel("gemini", "gemini-3.1-pro", 0);

    expect(model).toBeInstanceOf(ChatGoogle);
    expect(modelName(model)).toBe("gemini-3.1-pro");

    // Thought-signature workaround: streaming disabled + v0 output, on the AI
    // Studio ("gai") platform. (The API key is stored privately by ChatGoogle
    // and is asserted via the constructor mock in gemini-retry.test.ts.)
    const config = model as {
      _platform?: string;
      disableStreaming?: boolean;
      outputVersion?: string;
    };
    expect(config.disableStreaming).toBe(true);
    expect(config.outputVersion).toBe("v0");
    expect(config._platform).toBe("gai");
  });
});

describe("createModel OpenAI-compatible transport selection", () => {
  test("routes Copilot GPT-5 models through the Responses API", () => {
    const model = createModel("copilot", "gpt-5.5", 0) as {
      useResponsesApi?: boolean;
    };

    expect(model.useResponsesApi).toBe(true);
  });

  test("keeps non-GPT-5 Copilot models on chat completions", () => {
    const model = createModel("copilot", "claude-sonnet-5", 0) as {
      useResponsesApi?: boolean;
    };

    expect(model.useResponsesApi).toBe(false);
  });
});


describe("createModel xai-grok", () => {
  const keys = [
    XAI_GROK_ACCESS_TOKEN_ENV_KEY,
    XAI_GROK_REFRESH_TOKEN_ENV_KEY,
    XAI_GROK_EXPIRES_AT_ENV_KEY,
  ] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env[XAI_GROK_ACCESS_TOKEN_ENV_KEY] = "xai-access-token";
    process.env[XAI_GROK_REFRESH_TOKEN_ENV_KEY] = "xai-refresh-token";
    process.env[XAI_GROK_EXPIRES_AT_ENV_KEY] = String(
      Date.now() + 60 * 60 * 1000,
    );
  });

  afterEach(() => {
    for (const key of keys) {
      restoreEnv(key, saved[key]);
    }
  });

  test("builds ChatOpenAI against api.x.ai with the access token", () => {
    const model = createModel("xai-grok", "grok-4.5", 0);

    expect(model).toBeInstanceOf(ChatOpenAI);
    expect(modelName(model)).toBe("grok-4.5");

    const config = model as {
      apiKey?: string;
      clientConfig?: { baseURL?: string };
    };
    expect(config.apiKey ?? (model as { openAIApiKey?: string }).openAIApiKey).toBe(
      "xai-access-token",
    );
    expect(config.clientConfig?.baseURL).toBe(XAI_API_BASE_URL);
  });

  test("throws when the OAuth token set is incomplete", () => {
    delete process.env[XAI_GROK_ACCESS_TOKEN_ENV_KEY];

    expect(() => createModel("xai-grok", "grok-4.5", 0)).toThrow(
      /xAI Grok login is incomplete/u,
    );
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
