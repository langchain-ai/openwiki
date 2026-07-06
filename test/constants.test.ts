import { describe, expect, test } from "vitest";
import {
  ANTHROPIC_BASE_URL_ENV_KEY,
  ANTHROPIC_API_KEY_ENV_KEY,
  BASETEN_API_KEY_ENV_KEY,
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER,
  DEEPSEEK_API_KEY_ENV_KEY,
  FIREWORKS_API_KEY_ENV_KEY,
  OPENAI_API_KEY_ENV_KEY,
  OPENAI_COMPATIBLE_API_KEY_ENV_KEY,
  OPENAI_COMPATIBLE_BASE_URL_ENV_KEY,
  OPENROUTER_API_KEY_ENV_KEY,
  OPENROUTER_BASE_URL,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
  OPENWIKI_VERSION,
  PROVIDER_CONFIGS,
  SELECTABLE_OPENWIKI_PROVIDERS,
  SUGGESTED_MODEL_IDS,
  getDefaultModelId,
  getProviderApiKeyEnvKey,
  getProviderBaseUrlEnvKey,
  getProviderConfig,
  getProviderLabel,
  getProviderModelOptions,
  isValidBaseUrl,
  isValidModelId,
  isValidProvider,
  normalizeModelId,
  normalizeProvider,
  providerRequiresBaseUrl,
  resolveConfiguredProvider,
  resolveProviderBaseUrl,
  type OpenWikiProvider,
} from "../src/constants.ts";

// `PROVIDER_CONFIGS` is `Record<OpenWikiProvider, ProviderConfig>`, so its keys
// are exactly the members of the `OpenWikiProvider` union. This is used by the
// structural-invariant tests below to iterate every known provider.
const ALL_PROVIDERS = Object.keys(PROVIDER_CONFIGS) as OpenWikiProvider[];

describe("DeepSeek provider", () => {
  test("exposes a DeepSeek API key env key constant", () => {
    expect(DEEPSEEK_API_KEY_ENV_KEY).toBe("DEEPSEEK_API_KEY");
  });

  test("is a valid, selectable provider", () => {
    expect(isValidProvider("deepseek")).toBe(true);
  });

  test("is registered in the selectable provider list", () => {
    expect(SELECTABLE_OPENWIKI_PROVIDERS).toContain("deepseek");
  });

  test("has a complete provider config", () => {
    const config = getProviderConfig("deepseek");

    expect(config.apiKeyEnvKey).toBe(DEEPSEEK_API_KEY_ENV_KEY);
    expect(config.label).toBe("DeepSeek");
    expect(config.baseURL).toBe("https://api.deepseek.com/v1");
    expect(config.requiresBaseUrl).not.toBe(true);
    expect(config.baseUrlEnvKey).toBeUndefined();
  });

  test("ships documented model presets in a stable order", () => {
    expect(getProviderModelOptions("deepseek")).toEqual([
      { id: "deepseek-chat", label: "Chat" },
      { id: "deepseek-reasoner", label: "Reasoner" },
    ]);
  });

  test("defaults to the chat model", () => {
    expect(getDefaultModelId("deepseek")).toBe("deepseek-chat");
  });

  test("accessors resolve through the shared provider config", () => {
    expect(getProviderApiKeyEnvKey("deepseek")).toBe(DEEPSEEK_API_KEY_ENV_KEY);
    expect(getProviderLabel("deepseek")).toBe("DeepSeek");
    expect(getProviderBaseUrlEnvKey("deepseek")).toBeUndefined();
    expect(providerRequiresBaseUrl("deepseek")).toBe(false);
  });

  test("normalizes case and surrounding whitespace", () => {
    expect(normalizeProvider("deepseek")).toBe("deepseek");
    expect(normalizeProvider("DeepSeek")).toBe("deepseek");
    expect(normalizeProvider("DEEPSEEK")).toBe("deepseek");
    expect(normalizeProvider("  deepseek  ")).toBe("deepseek");
  });
});

describe("resolveConfiguredProvider", () => {
  test("honors OPENWIKI_PROVIDER for deepseek", () => {
    expect(
      resolveConfiguredProvider({ [OPENWIKI_PROVIDER_ENV_KEY]: "deepseek" }),
    ).toBe("deepseek");
  });

  test("falls back to the default provider when nothing is set", () => {
    expect(resolveConfiguredProvider({})).toBe(DEFAULT_PROVIDER);
    expect(DEFAULT_PROVIDER).toBe("openrouter");
  });

  test("falls back to openrouter when only an OpenRouter key is present", () => {
    expect(
      resolveConfiguredProvider({ [OPENROUTER_API_KEY_ENV_KEY]: "sk-or-..." }),
    ).toBe("openrouter");
  });

  test("prefers OPENWIKI_PROVIDER over an ambient OpenRouter key", () => {
    expect(
      resolveConfiguredProvider({
        [OPENWIKI_PROVIDER_ENV_KEY]: "deepseek",
        [OPENROUTER_API_KEY_ENV_KEY]: "sk-or-...",
      }),
    ).toBe("deepseek");
  });

  test("ignores an invalid OPENWIKI_PROVIDER value", () => {
    expect(
      resolveConfiguredProvider({ [OPENWIKI_PROVIDER_ENV_KEY]: "not-a-real" }),
    ).toBe(DEFAULT_PROVIDER);
  });
});

describe("resolveProviderBaseUrl", () => {
  test("returns the built-in DeepSeek endpoint", () => {
    expect(resolveProviderBaseUrl("deepseek", {})).toBe(
      "https://api.deepseek.com/v1",
    );
  });

  test("ignores unrelated env keys for DeepSeek (no override channel)", () => {
    expect(
      resolveProviderBaseUrl("deepseek", {
        [ANTHROPIC_BASE_URL_ENV_KEY]: "https://wrong.example.com",
      }),
    ).toBe("https://api.deepseek.com/v1");
  });

  test("honors ANTHROPIC_BASE_URL override for the anthropic provider", () => {
    expect(
      resolveProviderBaseUrl("anthropic", {
        [ANTHROPIC_BASE_URL_ENV_KEY]: "https://gateway.example.com/anthropic",
      }),
    ).toBe("https://gateway.example.com/anthropic");
  });

  test("returns undefined for openai-compatible with no base URL configured", () => {
    expect(resolveProviderBaseUrl("openai-compatible", {})).toBeUndefined();
  });

  test("returns undefined for providers whose SDK default is intended", () => {
    // `openai` has no built-in baseURL; it relies on the OpenAI SDK default.
    expect(resolveProviderBaseUrl("openai", {})).toBeUndefined();
  });

  test("trims whitespace from an override before using it", () => {
    expect(
      resolveProviderBaseUrl("anthropic", {
        [ANTHROPIC_BASE_URL_ENV_KEY]: "  https://gateway.example.com  ",
      }),
    ).toBe("https://gateway.example.com");
  });

  test("treats a blank override as unset", () => {
    expect(
      resolveProviderBaseUrl("anthropic", {
        [ANTHROPIC_BASE_URL_ENV_KEY]: "   ",
      }),
    ).toBeUndefined();
  });
});

describe("normalizeProvider / isValidProvider", () => {
  test("accepts every registered provider", () => {
    for (const provider of ALL_PROVIDERS) {
      expect(normalizeProvider(provider)).toBe(provider);
      expect(isValidProvider(provider)).toBe(true);
    }
  });

  test("rejects null, undefined, empty, and unknown values", () => {
    expect(normalizeProvider(null)).toBeNull();
    expect(normalizeProvider(undefined)).toBeNull();
    expect(normalizeProvider("")).toBeNull();
    expect(normalizeProvider("claude")).toBeNull();
    expect(normalizeProvider("openai-")).toBeNull();
    expect(isValidProvider("claude")).toBe(false);
  });
});

describe("isValidModelId", () => {
  test("accepts the DeepSeek model IDs", () => {
    expect(isValidModelId("deepseek-chat")).toBe(true);
    expect(isValidModelId("deepseek-reasoner")).toBe(true);
  });

  test("normalizes surrounding whitespace before validating", () => {
    expect(isValidModelId("  deepseek-chat  ")).toBe(true);
    expect(normalizeModelId("  deepseek-chat  ")).toBe("deepseek-chat");
  });

  test("rejects empty input", () => {
    expect(isValidModelId("")).toBe(false);
    expect(isValidModelId("   ")).toBe(false);
  });

  test("rejects IDs longer than 120 characters", () => {
    expect(isValidModelId("a".repeat(120))).toBe(true);
    expect(isValidModelId("a".repeat(121))).toBe(false);
  });

  test("rejects IDs that contain a scheme separator", () => {
    expect(isValidModelId("deepseek://foo")).toBe(false);
  });

  test("rejects IDs that start with a non-alphanumeric character", () => {
    expect(isValidModelId("-deepseek")).toBe(false);
    expect(isValidModelId("/deepseek")).toBe(false);
  });
});

describe("isValidBaseUrl", () => {
  test("accepts http and https URLs", () => {
    expect(isValidBaseUrl("https://api.deepseek.com/v1")).toBe(true);
    expect(isValidBaseUrl("http://localhost:8080")).toBe(true);
  });

  test("rejects empty, non-http(s), and malformed input", () => {
    expect(isValidBaseUrl("")).toBe(false);
    expect(isValidBaseUrl("   ")).toBe(false);
    expect(isValidBaseUrl("ftp://example.com")).toBe(false);
    expect(isValidBaseUrl("not-a-url")).toBe(false);
  });
});

describe("provider config accessors", () => {
  test("each provider resolves to its own config object", () => {
    expect(getProviderConfig("openrouter")).toBe(PROVIDER_CONFIGS.openrouter);
    expect(getProviderConfig("deepseek")).toBe(PROVIDER_CONFIGS.deepseek);
  });

  test("getProviderLabel mirrors the config label", () => {
    for (const provider of ALL_PROVIDERS) {
      expect(getProviderLabel(provider)).toBe(
        getProviderConfig(provider).label,
      );
    }
  });

  test("only the openai-compatible provider requires a base URL", () => {
    const requireBaseUrl = ALL_PROVIDERS.filter(providerRequiresBaseUrl);
    expect(requireBaseUrl).toEqual(["openai-compatible"]);
  });

  test("only anthropic and openai-compatible expose a base URL env override", () => {
    const withOverride = ALL_PROVIDERS.map((provider) => ({
      provider,
      key: getProviderBaseUrlEnvKey(provider),
    })).filter((entry) => entry.key !== undefined);

    expect(withOverride).toEqual([
      {
        provider: "openai-compatible",
        key: OPENAI_COMPATIBLE_BASE_URL_ENV_KEY,
      },
      { provider: "anthropic", key: ANTHROPIC_BASE_URL_ENV_KEY },
    ]);
  });
});

describe("structural invariants", () => {
  // These guard against the whole class of provider-wiring regressions that
  // this repo has hit before (e.g. a provider added to the type/selectable
  // list but missing from PROVIDER_CONFIGS, or presets that fail validation).

  test("every provider union member has a PROVIDER_CONFIGS entry", () => {
    for (const provider of ALL_PROVIDERS) {
      const config = getProviderConfig(provider);

      expect(typeof config.apiKeyEnvKey).toBe("string");
      expect(config.apiKeyEnvKey.length).toBeGreaterThan(0);
      expect(typeof config.label).toBe("string");
      expect(config.label.length).toBeGreaterThan(0);
      expect(Array.isArray(config.modelOptions)).toBe(true);
    }
  });

  test("every provider is present in SELECTABLE_OPENWIKI_PROVIDERS", () => {
    for (const provider of ALL_PROVIDERS) {
      expect(SELECTABLE_OPENWIKI_PROVIDERS).toContain(provider);
    }
  });

  test("SELECTABLE_OPENWIKI_PROVIDERS is deduplicated", () => {
    expect(new Set(SELECTABLE_OPENWIKI_PROVIDERS).size).toBe(
      SELECTABLE_OPENWIKI_PROVIDERS.length,
    );
  });

  test("every selectable entry is a valid provider", () => {
    for (const provider of SELECTABLE_OPENWIKI_PROVIDERS) {
      expect(isValidProvider(provider)).toBe(true);
    }
  });

  test("every provider's default model ID passes validation", () => {
    for (const provider of ALL_PROVIDERS) {
      const defaultModelId = getDefaultModelId(provider);

      expect(isValidModelId(defaultModelId)).toBe(true);
    }
  });

  test("every preset model ID passes validation", () => {
    for (const provider of ALL_PROVIDERS) {
      for (const option of getProviderModelOptions(provider)) {
        expect(isValidModelId(option.id)).toBe(true);
        expect(typeof option.label).toBe("string");
        expect(option.label.length).toBeGreaterThan(0);
      }
    }
  });

  test("API key env keys are unique per provider", () => {
    const keys = ALL_PROVIDERS.map(getProviderApiKeyEnvKey);

    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("module-level constants", () => {
  test("the default provider is openrouter", () => {
    expect(DEFAULT_PROVIDER).toBe("openrouter");
  });

  test("DEFAULT_MODEL_ID resolves to the first OpenRouter preset", () => {
    expect(DEFAULT_MODEL_ID).toBe(getProviderModelOptions("openrouter")[0]?.id);
  });

  test("SUGGESTED_MODEL_IDS mirrors the OpenRouter preset IDs", () => {
    expect(SUGGESTED_MODEL_IDS).toEqual(
      getProviderModelOptions("openrouter").map((model) => model.id),
    );
  });

  test("OPENROUTER_BASE_URL is the public endpoint", () => {
    expect(OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api/v1");
  });

  test("version is a non-empty semver-ish string", () => {
    expect(OPENWIKI_VERSION).toMatch(/^\d+\.\d+\.\d+/u);
  });

  test("the known env key constants keep their expected values", () => {
    expect(BASETEN_API_KEY_ENV_KEY).toBe("BASETEN_API_KEY");
    expect(DEEPSEEK_API_KEY_ENV_KEY).toBe("DEEPSEEK_API_KEY");
    expect(FIREWORKS_API_KEY_ENV_KEY).toBe("FIREWORKS_API_KEY");
    expect(OPENAI_API_KEY_ENV_KEY).toBe("OPENAI_API_KEY");
    expect(OPENAI_COMPATIBLE_API_KEY_ENV_KEY).toBe("OPENAI_COMPATIBLE_API_KEY");
    expect(OPENAI_COMPATIBLE_BASE_URL_ENV_KEY).toBe(
      "OPENAI_COMPATIBLE_BASE_URL",
    );
    expect(ANTHROPIC_API_KEY_ENV_KEY).toBe("ANTHROPIC_API_KEY");
    expect(ANTHROPIC_BASE_URL_ENV_KEY).toBe("ANTHROPIC_BASE_URL");
    expect(OPENROUTER_API_KEY_ENV_KEY).toBe("OPENROUTER_API_KEY");
    expect(OPENWIKI_PROVIDER_ENV_KEY).toBe("OPENWIKI_PROVIDER");
    expect(OPENWIKI_MODEL_ID_ENV_KEY).toBe("OPENWIKI_MODEL_ID");
  });
});
