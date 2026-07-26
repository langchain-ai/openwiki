import { describe, expect, test } from "vitest";
import {
  getProviderApiKeyEnvKey,
  getProviderAuthMethod,
  getProviderLabel,
  getProviderModelOptions,
  isValidProvider,
  providerUsesOAuth,
  SELECTABLE_OPENWIKI_PROVIDERS,
  XAI_GROK_ACCESS_TOKEN_ENV_KEY,
  XAI_GROK_EXPIRES_AT_ENV_KEY,
  XAI_GROK_REFRESH_TOKEN_ENV_KEY,
} from "../src/constants.ts";
import { MANAGED_ENV_KEYS } from "../src/env.ts";

describe("xai-grok provider config", () => {
  test("is a valid, selectable provider", () => {
    expect(isValidProvider("xai-grok")).toBe(true);
    expect(SELECTABLE_OPENWIKI_PROVIDERS).toContain("xai-grok");
  });

  test("uses oauth authentication", () => {
    expect(getProviderAuthMethod("xai-grok")).toBe("oauth");
    expect(providerUsesOAuth("xai-grok")).toBe(true);
  });

  test("has the Grok subscription label", () => {
    expect(getProviderLabel("xai-grok")).toBe("Grok (xAI subscription)");
  });

  test("ships static Grok model presets", () => {
    expect(getProviderModelOptions("xai-grok").map((m) => m.id)).toEqual([
      "grok-4.5",
      "grok-code-fast-1",
      "grok-4-1-fast-reasoning",
      "grok-4-1-fast-non-reasoning",
    ]);
  });

  test("its api-key env key is the access token", () => {
    expect(getProviderApiKeyEnvKey("xai-grok")).toBe(
      XAI_GROK_ACCESS_TOKEN_ENV_KEY,
    );
  });

  test("exposes the token env key constants and manages them", () => {
    expect(XAI_GROK_ACCESS_TOKEN_ENV_KEY).toBe("XAI_GROK_ACCESS_TOKEN");
    expect(XAI_GROK_REFRESH_TOKEN_ENV_KEY).toBe("XAI_GROK_REFRESH_TOKEN");
    expect(XAI_GROK_EXPIRES_AT_ENV_KEY).toBe("XAI_GROK_EXPIRES_AT");

    for (const key of [
      XAI_GROK_ACCESS_TOKEN_ENV_KEY,
      XAI_GROK_REFRESH_TOKEN_ENV_KEY,
      XAI_GROK_EXPIRES_AT_ENV_KEY,
    ]) {
      expect(MANAGED_ENV_KEYS).toContain(key);
    }
  });
});
