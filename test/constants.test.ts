import { describe, expect, test } from "vitest";
import {
  ANTHROPIC_BASE_URL_ENV_KEY,
  OPENAI_BASE_URL_ENV_KEY,
  PROVIDER_CONFIGS,
  getProviderBaseUrlEnvKey,
  isValidBaseUrl,
  providerRequiresBaseUrl,
  resolveProviderBaseUrl,
} from "../src/constants.ts";

describe("OpenAI base URL override (#64)", () => {
  test("exposes an OPENAI_BASE_URL env key constant", () => {
    expect(OPENAI_BASE_URL_ENV_KEY).toBe("OPENAI_BASE_URL");
  });

  test("the openai provider advertises OPENAI_BASE_URL as its override channel", () => {
    expect(getProviderBaseUrlEnvKey("openai")).toBe(OPENAI_BASE_URL_ENV_KEY);
    expect(PROVIDER_CONFIGS.openai.baseUrlEnvKey).toBe(OPENAI_BASE_URL_ENV_KEY);
  });

  test("does not require a base URL (the OpenAI default endpoint still applies)", () => {
    expect(providerRequiresBaseUrl("openai")).toBe(false);
  });

  test("resolveProviderBaseUrl returns undefined when no override is set", () => {
    expect(resolveProviderBaseUrl("openai", {})).toBeUndefined();
  });

  test("resolveProviderBaseUrl honors OPENAI_BASE_URL when set", () => {
    const gateway = "https://audit-gateway.example.com/v1";

    expect(
      resolveProviderBaseUrl("openai", {
        [OPENAI_BASE_URL_ENV_KEY]: gateway,
      }),
    ).toBe(gateway);
  });

  test("resolveProviderBaseUrl trims whitespace from the override", () => {
    expect(
      resolveProviderBaseUrl("openai", {
        [OPENAI_BASE_URL_ENV_KEY]: "  https://gateway.example.com/v1  ",
      }),
    ).toBe("https://gateway.example.com/v1");
  });

  test("resolveProviderBaseUrl treats a blank override as unset", () => {
    expect(
      resolveProviderBaseUrl("openai", {
        [OPENAI_BASE_URL_ENV_KEY]: "   ",
      }),
    ).toBeUndefined();
  });

  test("the override is isolated to the openai provider", () => {
    // OPENAI_BASE_URL must not bleed into the anthropic provider's resolution.
    expect(
      resolveProviderBaseUrl("anthropic", {
        [OPENAI_BASE_URL_ENV_KEY]: "https://wrong.example.com",
      }),
    ).toBeUndefined();
  });
});

describe("base URL override surface across providers", () => {
  test("anthropic, openai, and openai-compatible are the only providers with an override channel", () => {
    const providers = Object.keys(PROVIDER_CONFIGS);
    const withOverride = providers
      .map((provider) => getProviderBaseUrlEnvKey(provider as never))
      .filter((key): key is string => key !== undefined)
      .sort();

    expect(withOverride).toEqual(
      [
        ANTHROPIC_BASE_URL_ENV_KEY,
        OPENAI_BASE_URL_ENV_KEY,
        "OPENAI_COMPATIBLE_BASE_URL",
      ].sort(),
    );
  });
});

describe("isValidBaseUrl", () => {
  test("accepts http and https URLs", () => {
    expect(isValidBaseUrl("https://api.openai.com/v1")).toBe(true);
    expect(isValidBaseUrl("http://localhost:8080")).toBe(true);
  });

  test("rejects empty, non-http(s), and malformed input", () => {
    expect(isValidBaseUrl("")).toBe(false);
    expect(isValidBaseUrl("   ")).toBe(false);
    expect(isValidBaseUrl("ftp://example.com")).toBe(false);
    expect(isValidBaseUrl("not-a-url")).toBe(false);
  });
});
