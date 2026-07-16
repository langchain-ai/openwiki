import { describe, expect, test, vi } from "vitest";

const getAccessToken = vi.fn();

vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    getAccessToken = getAccessToken;
  },
}));

const {
  createVertexAuthFetch,
  resolveVertexSurface,
  stripPublisherPath,
  toVertexPublisherModel,
  vertexOpenAIBaseUrl,
  withAnthropicAuthEnvNeutralized,
} = await import("../src/agent/vertex-surface.ts");

describe("resolveVertexSurface", () => {
  test("routes Claude ids to the anthropic surface", () => {
    expect(resolveVertexSurface("claude-sonnet-4-5@20250929")).toBe(
      "anthropic",
    );
    expect(
      resolveVertexSurface("publishers/anthropic/models/claude-opus-4-1"),
    ).toBe("anthropic");
  });

  test("routes partner/MaaS ids to the openai-maas surface", () => {
    expect(resolveVertexSurface("meta/llama-3.3-70b-instruct-maas")).toBe(
      "openai-maas",
    );
    expect(resolveVertexSurface("mistralai/mistral-large-2411")).toBe(
      "openai-maas",
    );
    expect(resolveVertexSurface("deepseek-ai/deepseek-r1")).toBe("openai-maas");
    expect(resolveVertexSurface("qwen/qwen3-235b")).toBe("openai-maas");
  });

  test("defaults Gemini and Gemma ids to the gemini surface", () => {
    expect(resolveVertexSurface("gemini-3.1-pro")).toBe("gemini");
    expect(resolveVertexSurface("gemma-3-27b-it")).toBe("gemini");
  });

  test("is case-insensitive", () => {
    expect(resolveVertexSurface("Claude-Sonnet")).toBe("anthropic");
    expect(resolveVertexSurface("Meta/Llama-3")).toBe("openai-maas");
  });

  test("routes bare codellama ids to the openai-maas surface", () => {
    // `llama` alone would not match after the `code` prefix, so `codellama` is
    // listed explicitly in the MaaS pattern.
    expect(resolveVertexSurface("codellama-70b")).toBe("openai-maas");
  });

  test("does not misclassify a family token embedded mid-word", () => {
    // The (^|/) boundary means `meta`/`llama` only match at the start or after a
    // slash — a Gemini id that merely contains those letters stays on gemini.
    expect(resolveVertexSurface("gemini-metallica")).toBe("gemini");
    expect(resolveVertexSurface("publishers/google/models/gemini-3-pro")).toBe(
      "gemini",
    );
  });

  test("defaults unknown publishers to the gemini surface", () => {
    // A publisher not in the alternation falls through to gemini (keeps future
    // Google models zero-config); documents the intentional default.
    expect(resolveVertexSurface("some-unknown-model")).toBe("gemini");
  });
});

describe("stripPublisherPath", () => {
  test("reduces a publisher path to the bare model id", () => {
    expect(
      stripPublisherPath("publishers/anthropic/models/claude-sonnet-4-5"),
    ).toBe("claude-sonnet-4-5");
  });

  test("passes bare ids through unchanged", () => {
    expect(stripPublisherPath("claude-sonnet-4-5@20250929")).toBe(
      "claude-sonnet-4-5@20250929",
    );
  });
});

describe("toVertexPublisherModel", () => {
  test("reduces a full publisher path to publisher/model form", () => {
    expect(toVertexPublisherModel("publishers/meta/models/llama-3.3-70b")).toBe(
      "meta/llama-3.3-70b",
    );
  });

  test("passes already-short publisher/model ids through unchanged", () => {
    expect(toVertexPublisherModel("meta/llama-3.3-70b")).toBe(
      "meta/llama-3.3-70b",
    );
  });

  test("passes bare ids through unchanged", () => {
    expect(toVertexPublisherModel("llama-3.3-70b")).toBe("llama-3.3-70b");
  });
});

describe("vertexOpenAIBaseUrl", () => {
  test("builds the OpenAI-compatible endpoint URL for a regional location", () => {
    expect(vertexOpenAIBaseUrl("my-proj", "us-central1")).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/my-proj/locations/us-central1/endpoints/openapi",
    );
  });

  test("uses the unprefixed host for the global location", () => {
    // The global endpoint is aiplatform.googleapis.com (no location prefix);
    // global-aiplatform.googleapis.com is not a real host.
    expect(vertexOpenAIBaseUrl("my-proj", "global")).toBe(
      "https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/endpoints/openapi",
    );
  });
});

describe("withAnthropicAuthEnvNeutralized", () => {
  test("hides ANTHROPIC_API_KEY/AUTH_TOKEN during construction, restores after", () => {
    process.env.ANTHROPIC_API_KEY = "leak-key";
    process.env.ANTHROPIC_AUTH_TOKEN = "leak-token";

    const seen = withAnthropicAuthEnvNeutralized(() => ({
      key: process.env.ANTHROPIC_API_KEY,
      token: process.env.ANTHROPIC_AUTH_TOKEN,
    }));

    expect(seen.key).toBeUndefined();
    expect(seen.token).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBe("leak-key");
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe("leak-token");

    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });

  test("restores absence when the vars were unset", () => {
    delete process.env.ANTHROPIC_API_KEY;

    withAnthropicAuthEnvNeutralized(() => {
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      return null;
    });

    expect("ANTHROPIC_API_KEY" in process.env).toBe(false);
  });

  test("restores the value even if construction throws", () => {
    process.env.ANTHROPIC_API_KEY = "leak-key";

    expect(() =>
      withAnthropicAuthEnvNeutralized(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(process.env.ANTHROPIC_API_KEY).toBe("leak-key");

    delete process.env.ANTHROPIC_API_KEY;
  });
});

describe("createVertexAuthFetch", () => {
  test("injects a fresh bearer token on each request", async () => {
    getAccessToken.mockResolvedValue("token-abc");
    const baseFetch = vi.fn().mockResolvedValue(new Response("ok"));

    const authFetch = createVertexAuthFetch(baseFetch);
    await authFetch("https://example.test/v1/chat/completions", {
      method: "POST",
    });

    expect(baseFetch).toHaveBeenCalledTimes(1);
    const init = baseFetch.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer token-abc");
  });

  test("throws when no access token is available", async () => {
    getAccessToken.mockResolvedValue(null);
    const baseFetch = vi.fn().mockResolvedValue(new Response("ok"));

    const authFetch = createVertexAuthFetch(baseFetch);

    await expect(
      authFetch("https://example.test/v1/chat/completions"),
    ).rejects.toThrow(/access token/u);
    expect(baseFetch).not.toHaveBeenCalled();
  });
});
