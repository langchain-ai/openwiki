import { afterEach, describe, expect, test } from "vitest";
import {
  createModel,
  shouldInstallOpenRouterDebugFetch,
} from "../src/agent/index.ts";

type OpenAiModel = {
  clientConfig: {
    apiKey?: string;
    baseURL?: string;
    fetch?: unknown;
  };
};

const ENV_KEYS = [
  "OPENAI_COMPATIBLE_API_KEY",
  "OPENAI_COMPATIBLE_BASE_URL",
  "OPENROUTER_API_KEY",
  "ZAI_API_KEY",
  "ZAI_BASE_URL",
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("Z.AI model creation", () => {
  test("does not route Z.AI through the legacy global OpenRouter debug hook", () => {
    expect(shouldInstallOpenRouterDebugFetch("zai")).toBe(false);
    expect(shouldInstallOpenRouterDebugFetch("openrouter")).toBe(true);
  });

  test("uses ZAI credentials and a provider-local fetch adapter", () => {
    process.env.ZAI_API_KEY = "zai-test-key";
    process.env.ZAI_BASE_URL = "https://gateway.example/zai";
    process.env.OPENROUTER_API_KEY = "router-test-key";
    process.env.OPENAI_COMPATIBLE_API_KEY = "compatible-test-key";

    const model = createModel("zai", "glm-5.2", 3) as OpenAiModel;

    expect(model.clientConfig.apiKey).toBe("zai-test-key");
    expect(model.clientConfig.baseURL).toBe("https://gateway.example/zai");
    expect(typeof model.clientConfig.fetch).toBe("function");
  });

  test("does not install the Z.AI adapter for OpenAI-compatible clients", () => {
    process.env.OPENAI_COMPATIBLE_API_KEY = "compatible-test-key";
    process.env.OPENAI_COMPATIBLE_BASE_URL = "https://gateway.example/v1";

    const model = createModel(
      "openai-compatible",
      "gateway-model",
      3,
    ) as OpenAiModel;

    expect(model.clientConfig.fetch).toBeUndefined();
  });
});
