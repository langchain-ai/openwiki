import { describe, expect, test } from "vitest";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER,
  getDefaultModelId,
  getProviderAuthKind,
  getProviderCredentialEnvKey,
  getProviderRegionEnvKey,
  hasProviderRunCredentials,
  isValidBaseUrl,
  isValidModelId,
  isValidProvider,
  normalizeModelId,
  normalizeProvider,
  providerUsesAwsCredentials,
  resolveConfiguredProvider,
  resolveProviderBaseUrl,
  resolveProviderRegion,
} from "../src/constants.ts";

describe("isValidModelId", () => {
  test("accepts normal provider/model ids", () => {
    expect(isValidModelId("claude-opus-4-8")).toBe(true);
    expect(isValidModelId("z-ai/glm-5.2")).toBe(true);
    expect(isValidModelId("accounts/fireworks/models/glm-5p2")).toBe(true);
    expect(isValidModelId("gpt-5.4-mini")).toBe(true);
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
    expect(isValidProvider("openai-compatible")).toBe(true);
    expect(isValidProvider("bedrock")).toBe(true);
    expect(isValidProvider("nope")).toBe(false);
  });
});

describe("bedrock provider", () => {
  test("is registered with AWS-credential auth and a region env key", () => {
    expect(isValidProvider("bedrock")).toBe(true);
    expect(getProviderAuthKind("bedrock")).toBe("aws");
    expect(providerUsesAwsCredentials("bedrock")).toBe(true);
    expect(getProviderRegionEnvKey("bedrock")).toBe("AWS_REGION");
  });

  test("other providers default to api-key auth", () => {
    expect(getProviderAuthKind("anthropic")).toBe("api-key");
    expect(providerUsesAwsCredentials("openrouter")).toBe(false);
    expect(getProviderRegionEnvKey("openai")).toBeUndefined();
  });

  test("defaults to a global Bedrock inference profile that passes validation", () => {
    const defaultModel = getDefaultModelId("bedrock");

    expect(defaultModel).toBe("global.anthropic.claude-sonnet-5");
    expect(isValidModelId(defaultModel)).toBe(true);
    expect(isValidModelId("global.anthropic.claude-opus-4-8")).toBe(true);
  });

  test("resolveProviderRegion trims and treats blank as unset", () => {
    expect(
      resolveProviderRegion("bedrock", { AWS_REGION: "  us-east-1 " }),
    ).toBe("us-east-1");
    expect(
      resolveProviderRegion("bedrock", { AWS_REGION: "   " }),
    ).toBeUndefined();
    expect(resolveProviderRegion("bedrock", {})).toBeUndefined();
    expect(
      resolveProviderRegion("anthropic", { AWS_REGION: "x" }),
    ).toBeUndefined();
  });
});

describe("run credentials", () => {
  test("bedrock run credentials depend on region, not the API key", () => {
    expect(getProviderCredentialEnvKey("bedrock")).toBe("AWS_REGION");
    expect(hasProviderRunCredentials("bedrock", {})).toBe(false);
    expect(
      hasProviderRunCredentials("bedrock", { AWS_REGION: "us-east-1" }),
    ).toBe(true);
    // A Bedrock API key alone (no region) is not enough to run.
    expect(
      hasProviderRunCredentials("bedrock", { AWS_BEARER_TOKEN_BEDROCK: "t" }),
    ).toBe(false);
  });

  test("api-key providers depend on their single key", () => {
    expect(getProviderCredentialEnvKey("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(hasProviderRunCredentials("anthropic", {})).toBe(false);
    expect(
      hasProviderRunCredentials("anthropic", { ANTHROPIC_API_KEY: "k" }),
    ).toBe(true);
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

describe("getDefaultModelId", () => {
  test("returns the first model option for a provider", () => {
    expect(getDefaultModelId("anthropic")).toBe("claude-haiku-4-5");
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
