import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogle } from "@langchain/google/node";
import { ChatOpenAI } from "@langchain/openai";
import { createModel } from "../src/agent/index.ts";

// Constructing a LangChain chat model makes no network calls (auth/clients
// resolve lazily on first request), so these assert the gemini-enterprise
// surface dispatch and the project-id guard without needing GCP credentials.

const PROJECT_KEY = "GOOGLE_CLOUD_PROJECT";
const LOCATION_KEY = "GOOGLE_CLOUD_LOCATION";
const GEMINI_KEY = "GEMINI_API_KEY";
const COMPATIBLE_API_KEY = "OPENAI_COMPATIBLE_API_KEY";
const COMPATIBLE_BASE_URL = "OPENAI_COMPATIBLE_BASE_URL";
const COMPATIBLE_EXTRA_HEADERS = "OPENAI_COMPATIBLE_EXTRA_HEADERS";

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

describe("createModel openai-compatible extra headers", () => {
  let savedApiKey: string | undefined;
  let savedBaseUrl: string | undefined;
  let savedExtraHeaders: string | undefined;

  beforeEach(() => {
    savedApiKey = process.env[COMPATIBLE_API_KEY];
    savedBaseUrl = process.env[COMPATIBLE_BASE_URL];
    savedExtraHeaders = process.env[COMPATIBLE_EXTRA_HEADERS];
    process.env[COMPATIBLE_API_KEY] = "placeholder";
    process.env[COMPATIBLE_BASE_URL] = "https://gateway.example.com/v1";
    delete process.env[COMPATIBLE_EXTRA_HEADERS];
  });

  afterEach(() => {
    restoreEnv(COMPATIBLE_API_KEY, savedApiKey);
    restoreEnv(COMPATIBLE_BASE_URL, savedBaseUrl);
    restoreEnv(COMPATIBLE_EXTRA_HEADERS, savedExtraHeaders);
  });

  test("merges OPENAI_COMPATIBLE_EXTRA_HEADERS into ChatOpenAI defaultHeaders", () => {
    process.env[COMPATIBLE_EXTRA_HEADERS] = JSON.stringify({
      "Ocp-Apim-Subscription-Key": "apim-secret",
      "X-Tenant": "acme",
    });

    const model = createModel("openai-compatible", "gateway-model", 0);

    expect(model).toBeInstanceOf(ChatOpenAI);
    const clientConfig = (
      model as {
        clientConfig?: {
          baseURL?: string;
          defaultHeaders?: Record<string, string>;
        };
      }
    ).clientConfig;
    expect(clientConfig?.baseURL).toBe("https://gateway.example.com/v1");
    expect(clientConfig?.defaultHeaders).toEqual({
      "Ocp-Apim-Subscription-Key": "apim-secret",
      "X-Tenant": "acme",
    });
  });

  test("omits defaultHeaders when EXTRA_HEADERS is unset", () => {
    const model = createModel("openai-compatible", "gateway-model", 0);

    expect(model).toBeInstanceOf(ChatOpenAI);
    const clientConfig = (
      model as {
        clientConfig?: { defaultHeaders?: Record<string, string> };
      }
    ).clientConfig;
    expect(clientConfig?.defaultHeaders).toBeUndefined();
  });

  test("does not apply EXTRA_HEADERS to the openai provider", () => {
    const savedOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "openai-test-key";
    process.env[COMPATIBLE_EXTRA_HEADERS] = JSON.stringify({
      "Ocp-Apim-Subscription-Key": "should-not-apply",
    });

    try {
      const model = createModel("openai", "gpt-5.4-mini", 0);
      const clientConfig = (
        model as {
          clientConfig?: { defaultHeaders?: Record<string, string> };
        }
      ).clientConfig;
      expect(clientConfig?.defaultHeaders).toBeUndefined();
    } finally {
      restoreEnv("OPENAI_API_KEY", savedOpenAiKey);
    }
  });

  test("throws when EXTRA_HEADERS is invalid JSON", () => {
    process.env[COMPATIBLE_EXTRA_HEADERS] = "{";

    expect(() => createModel("openai-compatible", "gateway-model", 0)).toThrow(
      /OPENAI_COMPATIBLE_EXTRA_HEADERS/u,
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
