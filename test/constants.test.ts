import { describe, expect, test } from "vitest";
import {
  buildAwsAnthropicBaseUrl,
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_RETRY_ATTEMPTS,
  DEFAULT_PROVIDER,
  getDefaultModelId,
  getProviderModelOptions,
  isValidBaseUrl,
  isValidModelId,
  isValidProvider,
  normalizeModelId,
  normalizeProvider,
  resolveAwsRegion,
  resolveConfiguredProvider,
  resolveProviderBaseUrl,
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

  test("rejects empty, whitespace-only, and over-long ids", () => {
    expect(isValidModelId("")).toBe(false);
    expect(isValidModelId("   ")).toBe(false);
    expect(isValidModelId("a".repeat(121))).toBe(false);
    expect(isValidModelId("a".repeat(120))).toBe(true);
  });

  test("rejects ids containing a scheme (://)", () => {
    expect(isValidModelId("http://evil.example/model")).toBe(false);
  });

  test("rejects ids starting with a non-alphanumeric character", () => {
    expect(isValidModelId("-leading-dash")).toBe(false);
    expect(isValidModelId("/leading-slash")).toBe(false);
  });

  test("normalizeModelId trims surrounding whitespace", () => {
    expect(normalizeModelId("  claude-opus-4-8  ")).toBe("claude-opus-4-8");
  });
});

describe("normalizeProvider / isValidProvider", () => {
  test("normalizes case and whitespace to a known provider", () => {
    expect(normalizeProvider("  Anthropic ")).toBe("anthropic");
    expect(normalizeProvider("OPENROUTER")).toBe("openrouter");
  });

  test("returns null for unknown or nullish providers", () => {
    expect(normalizeProvider("bogus")).toBeNull();
    expect(normalizeProvider(null)).toBeNull();
    expect(normalizeProvider(undefined)).toBeNull();
  });

  test("isValidProvider is a type guard over the known set", () => {
    expect(isValidProvider("anthropic")).toBe(true);
    expect(isValidProvider("anthropic-aws")).toBe(true);
    expect(isValidProvider("openai-compatible")).toBe(true);
    expect(isValidProvider("nvidia")).toBe(true);
    expect(isValidProvider("nope")).toBe(false);
  });
});

describe("resolveConfiguredProvider", () => {
  test("honors an explicit OPENWIKI_PROVIDER", () => {
    expect(resolveConfiguredProvider({ OPENWIKI_PROVIDER: "anthropic" })).toBe(
      "anthropic",
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

  test("auto-selects anthropic-aws when only its API key is present", () => {
    expect(resolveConfiguredProvider({ ANTHROPIC_AWS_API_KEY: "x" })).toBe(
      "anthropic-aws",
    );
  });

  test("prefers anthropic-aws over first-party anthropic when both keys exist", () => {
    expect(
      resolveConfiguredProvider({
        ANTHROPIC_AWS_API_KEY: "aws",
        ANTHROPIC_API_KEY: "first-party",
      }),
    ).toBe("anthropic-aws");
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

  test("ignores a whitespace-only override", () => {
    // anthropic has no built-in default, so a blank override resolves to undefined.
    expect(
      resolveProviderBaseUrl("anthropic", { ANTHROPIC_BASE_URL: "   " }),
    ).toBeUndefined();
  });

  test("returns undefined for a provider with no default and no override", () => {
    expect(resolveProviderBaseUrl("openai", {})).toBeUndefined();
  });

  test("derives the anthropic-aws base URL from AWS_REGION", () => {
    expect(
      resolveProviderBaseUrl("anthropic-aws", { AWS_REGION: "us-west-2" }),
    ).toBe("https://aws-external-anthropic.us-west-2.api.aws");
  });

  test("derives the anthropic-aws base URL from AWS_DEFAULT_REGION fallback", () => {
    expect(
      resolveProviderBaseUrl("anthropic-aws", {
        AWS_DEFAULT_REGION: "eu-central-1",
      }),
    ).toBe("https://aws-external-anthropic.eu-central-1.api.aws");
  });

  test("prefers an explicit ANTHROPIC_AWS_BASE_URL override over the region", () => {
    expect(
      resolveProviderBaseUrl("anthropic-aws", {
        AWS_REGION: "us-west-2",
        ANTHROPIC_AWS_BASE_URL: "https://proxy.example/anthropic",
      }),
    ).toBe("https://proxy.example/anthropic");
  });

  test("returns undefined for anthropic-aws with no region and no override", () => {
    expect(resolveProviderBaseUrl("anthropic-aws", {})).toBeUndefined();
  });
});

describe("resolveAwsRegion / buildAwsAnthropicBaseUrl", () => {
  test("reads AWS_REGION, then AWS_DEFAULT_REGION, trimming whitespace", () => {
    expect(resolveAwsRegion({ AWS_REGION: " us-west-2 " })).toBe("us-west-2");
    expect(resolveAwsRegion({ AWS_DEFAULT_REGION: "eu-central-1" })).toBe(
      "eu-central-1",
    );
    expect(
      resolveAwsRegion({ AWS_REGION: "us-east-1", AWS_DEFAULT_REGION: "x" }),
    ).toBe("us-east-1");
  });

  test("returns undefined when neither region var is set or is blank", () => {
    expect(resolveAwsRegion({})).toBeUndefined();
    expect(resolveAwsRegion({ AWS_REGION: "   " })).toBeUndefined();
  });

  test("builds the region-scoped gateway URL", () => {
    expect(buildAwsAnthropicBaseUrl("ap-northeast-2")).toBe(
      "https://aws-external-anthropic.ap-northeast-2.api.aws",
    );
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

describe("getDefaultModelId", () => {
  test("returns the first model option for a provider", () => {
    expect(getDefaultModelId("anthropic")).toBe("claude-haiku-4-5");
    expect(getDefaultModelId("nvidia")).toBe(
      "nvidia/nemotron-3-super-120b-a12b",
    );
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
