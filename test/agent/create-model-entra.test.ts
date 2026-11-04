import { afterEach, describe, expect, test, vi } from "vitest";
import { ChatOpenAI } from "@langchain/openai";
import { createModel } from "../../src/agent/index.ts";

const BASE_URL = "https://gateway.example.com/openai/v1";
const SCOPE = "api://gateway/.default";

type OpenAiModelFields = {
  apiKey?: string | (() => Promise<string>);
  clientConfig: {
    apiKey?: string | (() => Promise<string>);
    baseURL?: string;
    fetch?: typeof fetch;
  };
  useResponsesApi?: boolean;
};

function openAiFields(model: unknown): OpenAiModelFields {
  return model as OpenAiModelFields;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createModel OpenAI-compatible Entra authentication", () => {
  test("preserves the static key in default and explicit API-key modes", () => {
    vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", BASE_URL);
    vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "fixture-static-key");

    for (const mode of [undefined, "api-key"]) {
      vi.stubEnv("OPENAI_COMPATIBLE_AUTH", mode);
      const model = createModel("openai-compatible", "customer-model", 0);
      const fields = openAiFields(model);

      expect(model).toBeInstanceOf(ChatOpenAI);
      expect(fields.apiKey).toBe("fixture-static-key");
      expect(fields.clientConfig.apiKey).toBe("fixture-static-key");
    }
  });

  test.each([
    ["Chat Completions", "false"],
    ["Responses", "true"],
  ])("passes a renewable callback to %s", (_transport, responsesApi) => {
    vi.stubEnv("OPENAI_COMPATIBLE_AUTH", "entra-id");
    vi.stubEnv("OPENAI_COMPATIBLE_ENTRA_SCOPE", SCOPE);
    vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", BASE_URL);
    vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "stale-static-key");
    vi.stubEnv("OPENWIKI_OPENAI_COMPATIBLE_USE_RESPONSES_API", responsesApi);

    const model = createModel("openai-compatible", "customer-model", 0);
    const fields = openAiFields(model);

    expect(model).toBeInstanceOf(ChatOpenAI);
    expect(fields.apiKey).toBeTypeOf("function");
    expect(fields.clientConfig.apiKey).toBe(fields.apiKey);
    expect(fields.apiKey).not.toBe("stale-static-key");
    expect(fields.useResponsesApi).toBe(responsesApi === "true");
    expect(fields.clientConfig.baseURL).toBe(BASE_URL);
    expect(fields.clientConfig.fetch).toBeTypeOf(
      responsesApi === "true" ? "undefined" : "function",
    );
  });

  test("rejects an unsafe endpoint before model construction", () => {
    vi.stubEnv("OPENAI_COMPATIBLE_AUTH", "entra-id");
    vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", "http://gateway.example.com/v1");
    vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "stale-static-key");

    expect(() => createModel("openai-compatible", "customer-model", 0)).toThrow(
      /Entra ID authentication requires an HTTPS OPENAI_COMPATIBLE_BASE_URL/u,
    );
  });

  test("rejects an invalid auth mode even with a static key", () => {
    vi.stubEnv("OPENAI_COMPATIBLE_AUTH", "entra");
    vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", BASE_URL);
    vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "stale-static-key");

    expect(() => createModel("openai-compatible", "customer-model", 0)).toThrow(
      "OPENAI_COMPATIBLE_AUTH must be one of: api-key, entra-id.",
    );
  });
});
