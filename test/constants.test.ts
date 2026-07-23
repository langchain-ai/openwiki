import { describe, expect, test } from "vitest";
import {
  BASETEN_BASE_URL_ENV_KEY,
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_RETRY_ATTEMPTS,
  DEFAULT_PROVIDER,
  DEFAULT_VERTEX_LOCATION,
  getDefaultModelId,
  getProviderBaseUrlWarnings,
  getMissingProviderEnvKey,
  getProviderApiKeyEnvKey,
  getProviderModelOptions,
  getProviderRegionEnvKey,
  FIREWORKS_BASE_URL_ENV_KEY,
  getProviderSecretKeyEnvKey,
  getProvidersForKnownModelId,
  isModelIdForOtherProvider,
  isValidBaseUrl,
  isValidProviderBaseUrl,
  isValidModelId,
  isValidProvider,
  NEBIUS_BASE_URL,
  NVIDIA_BASE_URL_ENV_KEY,
  normalizeModelId,
  normalizeProvider,
  providerRequiresApiKey,
  providerRequiresRegion,
  providerRequiresSecretKey,
  resolveConfiguredProvider,
  resolveOpenRouterProviderOnly,
  resolveProviderBaseUrl,
  resolveProviderLocation,
  resolveProviderRegion,
  resolveProviderRetryAttempts,
} from "../src/constants.ts";

describe("isValidModelId", () => {
  test("accepts normal provider/model ids", () => {
    expect(isValidModelId("claude-opus-4-8")).toBe(true);
    expect(isValidModelId("z-ai/glm-5.2")).toBe(true);
    expect(isValidModelId("accounts/fireworks/models/glm-5p2")).toBe(true);
    expect(isValidModelId("gpt-5.4-mini")).toBe(true);
    expect(isValidModelId("nvidia/nemotron-3-super-120b-a12b")).toBe(true);
  });

  test("accepts Cloudflare Workers AI model ids with leading '@'", () => {
    expect(isValidModelId("@cf/meta/llama-3-8b-instruct")).toBe(true);
    expect(isValidModelId("@cf/moonshotai/kimi-k2.7-code")).toBe(true);
    expect(isValidModelId("@cf/qwen/qwen1.5-14b-chat-awq")).toBe(true);
  });

  test("rejects empty, whitespace-only, and over-long ids", () => {
    expect(isValidModelId("")).toBe(false);
    expect(isValidModelId("   ")).toBe(false);
    expect(isValidModelId("a".repeat(121))).toBe(false);
    expect(isValidModelId("a".repeat(120))).toBe(true);
  });

  test("rejects ids containing a scheme (://)", () => {
    expect(isValidModelId("http://evil.example/model")).toBe(false);
  });

  test("accepts @-versioned Vertex AI model ids", () => {
    expect(isValidModelId("claude-haiku-4-5@20251001")).toBe(true);
  });

  test("rejects ids starting with a disallowed non-alphanumeric character", () => {
    expect(isValidModelId("-leading-dash")).toBe(false);
    expect(isValidModelId("/leading-slash")).toBe(false);
    // A leading "@" is intentionally allowed for Cloudflare Workers AI ids
    // (covered above), so it is not rejected here.
  });

  test("normalizeModelId trims surrounding whitespace", () => {
    expect(normalizeModelId("  claude-opus-4-8  ")).toBe("claude-opus-4-8");
  });
});

describe("normalizeProvider / isValidProvider", () => {
  test("normalizes case and whitespace to a known provider", () => {
    expect(normalizeProvider("  Anthropic ")).toBe("anthropic");
    expect(normalizeProvider("OPENROUTER")).toBe("openrouter");
    expect(normalizeProvider(" Nebius ")).toBe("nebius");
    expect(normalizeProvider(" Gemini-Enterprise ")).toBe("gemini-enterprise");
  });

  test("returns null for unknown or nullish providers", () => {
    expect(normalizeProvider("bogus")).toBeNull();
    expect(normalizeProvider(null)).toBeNull();
    expect(normalizeProvider(undefined)).toBeNull();
  });

  test("isValidProvider is a type guard over the known set", () => {
    expect(isValidProvider("anthropic")).toBe(true);
    expect(isValidProvider("nebius")).toBe(true);
    expect(isValidProvider("openai-compatible")).toBe(true);
    expect(isValidProvider("nvidia")).toBe(true);
    expect(isValidProvider("gemini")).toBe(true);
    expect(isValidProvider("gemini-enterprise")).toBe(true);
    expect(isValidProvider("nope")).toBe(false);
  });
});

describe("resolveConfiguredProvider", () => {
  test("honors an explicit OPENWIKI_PROVIDER", () => {
    expect(resolveConfiguredProvider({ OPENWIKI_PROVIDER: "anthropic" })).toBe(
      "anthropic",
    );
  });

  test("honors an explicit gemini / gemini-enterprise provider", () => {
    expect(resolveConfiguredProvider({ OPENWIKI_PROVIDER: "gemini" })).toBe(
      "gemini",
    );
    expect(
      resolveConfiguredProvider({ OPENWIKI_PROVIDER: "gemini-enterprise" }),
    ).toBe("gemini-enterprise");
  });

  test("does NOT auto-select gemini from GEMINI_API_KEY alone", () => {
    // The Google providers are explicit-only (like the removed vertex provider);
    // a bare GEMINI_API_KEY falls through to the default rather than selecting
    // gemini. Pinned so a future change can't silently flip it.
    expect(resolveConfiguredProvider({ GEMINI_API_KEY: "x" })).toBe(
      DEFAULT_PROVIDER,
    );
  });

  test("falls back to openrouter when only an OpenRouter key is present", () => {
    expect(resolveConfiguredProvider({ OPENROUTER_API_KEY: "x" })).toBe(
      "openrouter",
    );
  });

  test("falls back to nvidia when only an NVIDIA key is present", () => {
    expect(resolveConfiguredProvider({ NVIDIA_API_KEY: "x" })).toBe("nvidia");
  });

  test("falls back to bedrock when only a Bedrock access key is present", () => {
    expect(resolveConfiguredProvider({ BEDROCK_AWS_ACCESS_KEY_ID: "x" })).toBe(
      "bedrock",
    );
  });

  test("falls back to the default provider when nothing is configured", () => {
    expect(resolveConfiguredProvider({})).toBe(DEFAULT_PROVIDER);
  });

  test("ignores an invalid OPENWIKI_PROVIDER value", () => {
    expect(resolveConfiguredProvider({ OPENWIKI_PROVIDER: "bogus" })).toBe(
      DEFAULT_PROVIDER,
    );
  });
});

describe("resolveProviderBaseUrl", () => {
  test("returns the built-in default when no override is set", () => {
    expect(resolveProviderBaseUrl("openrouter", {})).toBe(
      "https://openrouter.ai/api/v1",
    );
    expect(resolveProviderBaseUrl("nebius", {})).toBe(NEBIUS_BASE_URL);
    expect(resolveProviderBaseUrl("nvidia", {})).toBe(
      "https://integrate.api.nvidia.com/v1",
    );
  });

  test("prefers a non-empty env override over the default", () => {
    expect(
      resolveProviderBaseUrl("anthropic", {
        ANTHROPIC_BASE_URL: "https://gateway.example/anthropic",
      }),
    ).toBe("https://gateway.example/anthropic");
  });

  test("prefers hosted OpenAI-compatible provider base URL overrides", () => {
    expect(
      resolveProviderBaseUrl("baseten", {
        [BASETEN_BASE_URL_ENV_KEY]: "https://gateway.example/baseten/v1",
      }),
    ).toBe("https://gateway.example/baseten/v1");
    expect(
      resolveProviderBaseUrl("fireworks", {
        [FIREWORKS_BASE_URL_ENV_KEY]: "https://gateway.example/fireworks/v1",
      }),
    ).toBe("https://gateway.example/fireworks/v1");
    expect(
      resolveProviderBaseUrl("nvidia", {
        [NVIDIA_BASE_URL_ENV_KEY]: "https://gateway.example/nvidia/v1",
      }),
    ).toBe("https://gateway.example/nvidia/v1");
  });

  test("ignores a whitespace-only override", () => {
    // anthropic has no built-in default, so a blank override resolves to undefined.
    expect(
      resolveProviderBaseUrl("anthropic", { ANTHROPIC_BASE_URL: "   " }),
    ).toBeUndefined();
    expect(
      resolveProviderBaseUrl("baseten", { [BASETEN_BASE_URL_ENV_KEY]: "   " }),
    ).toBe("https://inference.baseten.co/v1");
    expect(
      resolveProviderBaseUrl("fireworks", {
        [FIREWORKS_BASE_URL_ENV_KEY]: "   ",
      }),
    ).toBe("https://api.fireworks.ai/inference/v1");
    expect(
      resolveProviderBaseUrl("nvidia", { [NVIDIA_BASE_URL_ENV_KEY]: "   " }),
    ).toBe("https://integrate.api.nvidia.com/v1");
  });

  test("returns undefined for a provider with no default and no override", () => {
    expect(resolveProviderBaseUrl("openai", {})).toBeUndefined();
  });
});

describe("resolveProviderRetryAttempts", () => {
  test("uses the OpenWiki default when no override is set", () => {
    expect(resolveProviderRetryAttempts({})).toBe(
      DEFAULT_PROVIDER_RETRY_ATTEMPTS,
    );
  });

  test("accepts positive integer retry counts", () => {
    expect(
      resolveProviderRetryAttempts({
        OPENWIKI_PROVIDER_RETRY_ATTEMPTS: "1",
      }),
    ).toBe(1);
    expect(
      resolveProviderRetryAttempts({
        OPENWIKI_PROVIDER_RETRY_ATTEMPTS: " 3 ",
      }),
    ).toBe(3);
  });

  test("rejects invalid retry counts", () => {
    for (const value of ["", "   ", "0", "-1", "1.5", "abc", "1e2"]) {
      expect(() =>
        resolveProviderRetryAttempts({
          OPENWIKI_PROVIDER_RETRY_ATTEMPTS: value,
        }),
      ).toThrow(/OPENWIKI_PROVIDER_RETRY_ATTEMPTS/u);
    }
  });
});

describe("resolveOpenRouterProviderOnly", () => {
  test("returns undefined when no provider pin is configured", () => {
    expect(resolveOpenRouterProviderOnly({})).toBeUndefined();
    expect(
      resolveOpenRouterProviderOnly({
        OPENWIKI_OPENROUTER_PROVIDER_ONLY: "   ",
      }),
    ).toBeUndefined();
  });

  test("normalizes a single provider name", () => {
    expect(
      resolveOpenRouterProviderOnly({
        OPENWIKI_OPENROUTER_PROVIDER_ONLY: "  Novita  ",
      }),
    ).toEqual(["Novita"]);
  });

  test("normalizes a comma-separated provider allowlist", () => {
    expect(
      resolveOpenRouterProviderOnly({
        OPENWIKI_OPENROUTER_PROVIDER_ONLY: "Novita, Fireworks,, Together",
      }),
    ).toEqual(["Novita", "Fireworks", "Together"]);
  });
});

describe("isValidBaseUrl", () => {
  test("accepts http and https URLs", () => {
    expect(isValidBaseUrl("https://api.example.com/v1")).toBe(true);
    expect(isValidBaseUrl("http://localhost:8080")).toBe(true);
  });

  test("rejects blank, non-URL, and non-http(s) schemes", () => {
    expect(isValidBaseUrl("")).toBe(false);
    expect(isValidBaseUrl("   ")).toBe(false);
    expect(isValidBaseUrl("not a url")).toBe(false);
    expect(isValidBaseUrl("ftp://example.com")).toBe(false);
  });
});

describe("isValidProviderBaseUrl", () => {
  test("accepts OpenAI-compatible API root URLs", () => {
    expect(
      isValidProviderBaseUrl(
        "openai-compatible",
        "https://gateway.example.com/v1",
      ),
    ).toBe(true);
  });

  test("rejects OpenAI-compatible chat completions endpoint URLs", () => {
    expect(
      isValidProviderBaseUrl(
        "openai-compatible",
        "https://gateway.example.com/v1/chat/completions",
      ),
    ).toBe(false);
    expect(
      getProviderBaseUrlWarnings(
        "openai-compatible",
        "https://gateway.example.com/v1/chat/completions/",
      ),
    ).toContain("use API root URL, not /chat/completions endpoint");
  });

  test("keeps generic http URL validation for other provider base URLs", () => {
    expect(isValidProviderBaseUrl("anthropic", "not a url")).toBe(false);
    expect(
      getProviderBaseUrlWarnings("anthropic", "https://proxy.example.com"),
    ).toEqual([]);
  });
});

describe("getProviderModelOptions", () => {
  test("returns OpenAI models in display order", () => {
    expect(getProviderModelOptions("openai")).toEqual([
      { id: "gpt-5.6-terra", label: "5.6 Terra" },
      { id: "gpt-5.6-luna", label: "5.6 Luna" },
      { id: "gpt-5.6-sol", label: "5.6 Sol" },
      { id: "gpt-5.5", label: "5.5" },
      { id: "gpt-5.4-mini", label: "5.4 mini" },
    ]);
  });
});

describe("bedrock provider (IAM access key + secret key + region)", () => {
  test("requires a secret key and a region, unlike API-key providers", () => {
    expect(providerRequiresSecretKey("bedrock")).toBe(true);
    expect(providerRequiresRegion("bedrock")).toBe(true);
    expect(providerRequiresSecretKey("anthropic")).toBe(false);
    expect(providerRequiresRegion("anthropic")).toBe(false);
  });

  test("exposes the AWS-flavored env keys", () => {
    expect(getProviderSecretKeyEnvKey("bedrock")).toBe(
      "BEDROCK_AWS_SECRET_ACCESS_KEY",
    );
    expect(getProviderRegionEnvKey("bedrock")).toBe("BEDROCK_AWS_REGION");
  });

  test("resolveProviderRegion reads the region env key and trims it", () => {
    expect(
      resolveProviderRegion("bedrock", { BEDROCK_AWS_REGION: " us-east-1 " }),
    ).toBe("us-east-1");
    expect(resolveProviderRegion("bedrock", {})).toBeUndefined();
  });

  test("has no preset model list (Bedrock model availability is account/region specific)", () => {
    expect(getProviderModelOptions("bedrock")).toEqual([]);
  });
});

describe("providerRequiresApiKey / getProviderApiKeyEnvKey", () => {
  test("gemini-enterprise authenticates without an API key", () => {
    expect(providerRequiresApiKey("gemini-enterprise")).toBe(false);
    expect(getProviderApiKeyEnvKey("gemini-enterprise")).toBeUndefined();
  });

  test("key-based providers still require one", () => {
    expect(providerRequiresApiKey("anthropic")).toBe(true);
    expect(providerRequiresApiKey("openrouter")).toBe(true);
    expect(getProviderApiKeyEnvKey("anthropic")).toBe("ANTHROPIC_API_KEY");
  });
});

describe("getMissingProviderEnvKey", () => {
  test("reports the missing API key for key-based providers", () => {
    expect(getMissingProviderEnvKey("anthropic", {})).toBe("ANTHROPIC_API_KEY");
    expect(
      getMissingProviderEnvKey("anthropic", { ANTHROPIC_API_KEY: "k" }),
    ).toBeNull();
  });

  test("reports the missing GCP project for gemini-enterprise", () => {
    expect(getMissingProviderEnvKey("gemini-enterprise", {})).toBe(
      "GOOGLE_CLOUD_PROJECT",
    );
    expect(
      getMissingProviderEnvKey("gemini-enterprise", {
        GOOGLE_CLOUD_PROJECT: "proj",
      }),
    ).toBeNull();
  });

  test("does not require the optional gemini-enterprise location", () => {
    expect(
      getMissingProviderEnvKey("gemini-enterprise", {
        GOOGLE_CLOUD_PROJECT: "proj",
        GOOGLE_CLOUD_LOCATION: undefined,
      }),
    ).toBeNull();
  });
});

describe("resolveProviderLocation", () => {
  test("defaults gemini-enterprise to the global endpoint", () => {
    expect(resolveProviderLocation("gemini-enterprise", {})).toBe(
      DEFAULT_VERTEX_LOCATION,
    );
  });

  test("prefers a trimmed env override over the default", () => {
    expect(
      resolveProviderLocation("gemini-enterprise", {
        GOOGLE_CLOUD_LOCATION: " europe-west1 ",
      }),
    ).toBe("europe-west1");
  });

  test("ignores a whitespace-only override", () => {
    expect(
      resolveProviderLocation("gemini-enterprise", {
        GOOGLE_CLOUD_LOCATION: "   ",
      }),
    ).toBe(DEFAULT_VERTEX_LOCATION);
  });

  test("returns undefined for providers without a location concept", () => {
    expect(resolveProviderLocation("openai", {})).toBeUndefined();
  });
});

describe("getProviderModelOptions", () => {
  test("offers the latest Gemini Flash models on both Gemini providers", () => {
    const expectedModels = [
      { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
      { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
    ];

    for (const provider of ["gemini", "gemini-enterprise"] as const) {
      expect(getProviderModelOptions(provider)).toEqual(
        expect.arrayContaining(expectedModels),
      );
    }
  });
});

describe("getDefaultModelId", () => {
  test("returns the first model option for a provider", () => {
    expect(getDefaultModelId("anthropic")).toBe("claude-haiku-4-5");
    expect(getDefaultModelId("nebius")).toBe("moonshotai/Kimi-K2.6");
    expect(getDefaultModelId("nvidia")).toBe(
      "nvidia/nemotron-3-super-120b-a12b",
    );
    expect(getDefaultModelId("gemini")).toBe("gemini-3.6-flash");
    expect(getDefaultModelId("gemini-enterprise")).toBe("gemini-3.6-flash");
    expect(getDefaultModelId(DEFAULT_PROVIDER)).toBe(DEFAULT_MODEL_ID);
  });

  test(
    "openai-compatible has no presets, so it falls back to the global " +
      "DEFAULT_MODEL_ID (a known cross-provider quirk documented here)",
    () => {
      // This asserts CURRENT behavior: openai-compatible has an empty
      // modelOptions list, so getDefaultModelId yields an OpenRouter id.
      // If this ever changes intentionally, update this test.
      expect(getDefaultModelId("openai-compatible")).toBe(DEFAULT_MODEL_ID);
    },
  );
});

describe("getProvidersForKnownModelId", () => {
  test("finds the provider(s) whose known models include the id", () => {
    // claude-opus-4-8 is a known model of both anthropic and the
    // gemini-enterprise gateway, which also serves Claude models.
    expect(getProvidersForKnownModelId("claude-opus-4-8", "openai")).toEqual([
      "anthropic",
      "gemini-enterprise",
    ]);
  });

  test("excludes the provider passed in", () => {
    // Excluding anthropic still leaves gemini-enterprise, which also lists it.
    expect(getProvidersForKnownModelId("claude-opus-4-8", "anthropic")).toEqual(
      ["gemini-enterprise"],
    );
  });

  test("uses exact matching, so namespaced overlaps do not false-match", () => {
    // Anthropic's bare "claude-opus-4-8" must not match OpenRouter's
    // namespaced "anthropic/claude-opus-4-8" or vice versa.
    expect(
      getProvidersForKnownModelId("anthropic/claude-opus-4-8", "openai"),
    ).toEqual(["openrouter"]);
    expect(
      getProvidersForKnownModelId("anthropic/claude-opus-4-8", "openrouter"),
    ).toEqual([]);
  });

  test("returns empty for custom / unknown model ids", () => {
    expect(
      getProvidersForKnownModelId("my-gateway-model", "openai-compatible"),
    ).toEqual([]);
  });
});

describe("isModelIdForOtherProvider", () => {
  test("flags a model that clearly belongs to a different provider", () => {
    expect(isModelIdForOtherProvider("claude-opus-4-8", "openai")).toBe(true);
  });

  test("does not flag a model that is valid for the configured provider", () => {
    expect(isModelIdForOtherProvider("claude-opus-4-8", "anthropic")).toBe(
      false,
    );
  });

  test("does not flag shared OpenAI models across openai / openai-chatgpt", () => {
    const [firstOpenAiModel] = getProviderModelOptions("openai");
    if (firstOpenAiModel) {
      expect(
        isModelIdForOtherProvider(firstOpenAiModel.id, "openai-chatgpt"),
      ).toBe(false);
    }
  });

  test("does not flag custom / unknown model ids", () => {
    expect(
      isModelIdForOtherProvider("my-gateway-model", "openai-compatible"),
    ).toBe(false);
  });

  test("trims whitespace before comparing", () => {
    expect(isModelIdForOtherProvider("  claude-opus-4-8  ", "openai")).toBe(
      true,
    );
  });
});
