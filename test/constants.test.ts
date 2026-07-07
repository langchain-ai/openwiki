import { describe, expect, test } from "vitest";
import {
  AZURE_OPENAI_API_KEY_ENV_KEY,
  AZURE_OPENAI_ENDPOINT_ENV_KEY,
  azureUsesAdToken,
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER,
  getDefaultModelId,
  getMissingProviderEnvKey,
  getProviderApiKeyEnvKey,
  getProviderCredentialHint,
  getProviderEndpointEnvKey,
  isValidBaseUrl,
  isValidModelId,
  isValidProvider,
  normalizeModelId,
  normalizeProvider,
  providerRequiresApiKey,
  providerSupportsAdToken,
  resolveConfiguredProvider,
  resolveProviderBaseUrl,
  SELECTABLE_OPENWIKI_PROVIDERS,
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

describe("azure provider", () => {
  test("is selectable and a valid provider", () => {
    expect(SELECTABLE_OPENWIKI_PROVIDERS).toContain("azure");
    expect(isValidProvider("azure")).toBe(true);
    expect(normalizeProvider("Azure")).toBe("azure");
  });

  test("declares an API key and an endpoint env key", () => {
    expect(getProviderApiKeyEnvKey("azure")).toBe(AZURE_OPENAI_API_KEY_ENV_KEY);
    expect(getProviderEndpointEnvKey("azure")).toBe(
      AZURE_OPENAI_ENDPOINT_ENV_KEY,
    );
  });

  test("supports Entra ID token auth, so the API key is not strictly required", () => {
    expect(providerSupportsAdToken("azure")).toBe(true);
    expect(providerRequiresApiKey("azure")).toBe(false);
    // Providers with only an API key still require it.
    expect(providerRequiresApiKey("openai")).toBe(true);
    expect(providerSupportsAdToken("openai")).toBe(false);
  });

  test("getMissingProviderEnvKey gates on the endpoint, not the key", () => {
    // No endpoint → endpoint is the missing key even with a key present.
    expect(
      getMissingProviderEnvKey("azure", {
        [AZURE_OPENAI_API_KEY_ENV_KEY]: "k",
      }),
    ).toBe(AZURE_OPENAI_ENDPOINT_ENV_KEY);

    // Endpoint present, no key → satisfied (token auth is the fallback).
    expect(
      getMissingProviderEnvKey("azure", {
        [AZURE_OPENAI_ENDPOINT_ENV_KEY]: "https://r.openai.azure.com/",
      }),
    ).toBeNull();

    // Endpoint + key present → satisfied.
    expect(
      getMissingProviderEnvKey("azure", {
        [AZURE_OPENAI_ENDPOINT_ENV_KEY]: "https://r.openai.azure.com/",
        [AZURE_OPENAI_API_KEY_ENV_KEY]: "k",
      }),
    ).toBeNull();
  });

  test("azureUsesAdToken prefers the flag, then falls back when no key is set", () => {
    // No key at all → token auth.
    expect(azureUsesAdToken({})).toBe(true);
    // Key present, no flag → key auth.
    expect(azureUsesAdToken({ [AZURE_OPENAI_API_KEY_ENV_KEY]: "k" })).toBe(
      false,
    );
    // Key present but flag forces token auth.
    expect(
      azureUsesAdToken({
        [AZURE_OPENAI_API_KEY_ENV_KEY]: "k",
        AZURE_OPENAI_USE_AD_TOKEN: "true",
      }),
    ).toBe(true);
    expect(
      azureUsesAdToken({
        [AZURE_OPENAI_API_KEY_ENV_KEY]: "k",
        AZURE_OPENAI_USE_AD_TOKEN: "1",
      }),
    ).toBe(true);
    // Unrecognized flag value with a key → key auth.
    expect(
      azureUsesAdToken({
        [AZURE_OPENAI_API_KEY_ENV_KEY]: "k",
        AZURE_OPENAI_USE_AD_TOKEN: "maybe",
      }),
    ).toBe(false);
  });

  test("exposes an Entra ID credential hint for azure only", () => {
    expect(getProviderCredentialHint("azure")).toMatch(/Entra ID/u);
    expect(getProviderCredentialHint("openai")).toBeNull();
  });

  test("has no preset models (deployment name comes from OPENWIKI_MODEL_ID)", () => {
    expect(getDefaultModelId("azure")).toBe(DEFAULT_MODEL_ID);
  });
});
