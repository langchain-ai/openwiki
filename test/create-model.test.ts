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

describe("createModel omniroute", () => {
  const API_KEY = "OMNIROUTE_API_KEY";
  const BASE_URL_KEY = "OMNIROUTE_BASE_URL";
  const MODE_KEY = "OPENWIKI_OMNIROUTE_MODE";
  const BUDGET_KEY = "OPENWIKI_OMNIROUTE_BUDGET";
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [API_KEY, BASE_URL_KEY, MODE_KEY, BUDGET_KEY]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }

    process.env[API_KEY] = "test-omniroute-key";
  });

  afterEach(() => {
    for (const key of [API_KEY, BASE_URL_KEY, MODE_KEY, BUDGET_KEY]) {
      restoreEnv(key, saved[key]);
    }
  });

  test("targets the hosted gateway with no routing headers by default", () => {
    const model = createModel("omniroute", "auto/best-coding", 0);

    expect(model).toBeInstanceOf(ChatOpenAI);
    expect(modelName(model)).toBe("auto/best-coding");
    expect(clientConfig(model).baseURL).toBe(
      "https://omnirouterapi.virtualpeople.net/v1",
    );
    expect(clientConfig(model).defaultHeaders).toBeUndefined();
  });

  test("honors a self-hosted base URL override", () => {
    process.env[BASE_URL_KEY] = "http://localhost:20128/v1";

    const model = createModel("omniroute", "auto/best-coding", 0);

    expect(clientConfig(model).baseURL).toBe("http://localhost:20128/v1");
  });

  test("sends X-OmniRoute-Mode when a mode is configured", () => {
    process.env[MODE_KEY] = "quality";

    const headers = clientConfig(
      createModel("omniroute", "auto/best-coding", 0),
    ).defaultHeaders;

    expect(headers).toEqual({ "X-OmniRoute-Mode": "quality" });
  });

  test("sends X-OmniRoute-Budget when a budget is configured", () => {
    process.env[BUDGET_KEY] = "0.25";

    const headers = clientConfig(
      createModel("omniroute", "auto/best-coding", 0),
    ).defaultHeaders;

    expect(headers).toEqual({ "X-OmniRoute-Budget": "0.25" });
  });

  test("sends both routing headers when both are configured", () => {
    process.env[MODE_KEY] = "cheap";
    process.env[BUDGET_KEY] = "2";

    const headers = clientConfig(
      createModel("omniroute", "auto/cheap", 0),
    ).defaultHeaders;

    expect(headers).toEqual({
      "X-OmniRoute-Mode": "cheap",
      "X-OmniRoute-Budget": "2",
    });
  });

  test("drops a malformed budget instead of failing the run", () => {
    process.env[BUDGET_KEY] = "abc";

    let model: unknown;
    expect(() => {
      model = createModel("omniroute", "auto/best-coding", 0);
    }).not.toThrow();
    expect(clientConfig(model).defaultHeaders).toBeUndefined();
  });

  test("does not leak routing headers onto other OpenAI-compatible providers", () => {
    process.env[MODE_KEY] = "quality";
    process.env.NEBIUS_API_KEY = "test-nebius-key";

    try {
      const model = createModel("nebius", "moonshotai/Kimi-K2.6", 0);

      expect(clientConfig(model).defaultHeaders).toBeUndefined();
    } finally {
      delete process.env.NEBIUS_API_KEY;
    }
  });
});

function clientConfig(model: unknown): {
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
} {
  return (
    (
      model as {
        clientConfig?: {
          baseURL?: string;
          defaultHeaders?: Record<string, string>;
        };
      }
    ).clientConfig ?? {}
  );
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
