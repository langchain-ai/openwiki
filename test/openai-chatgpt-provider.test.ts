import { describe, expect, test } from "vitest";
import {
  getProviderApiKeyEnvKey,
  getProviderAuthMethod,
  getProviderLabel,
  getProviderModelOptions,
  isValidProvider,
  OPENAI_CHATGPT_ACCESS_TOKEN_ENV_KEY,
  OPENAI_CHATGPT_ACCOUNT_ID_ENV_KEY,
  OPENAI_CHATGPT_EXPIRES_AT_ENV_KEY,
  OPENAI_CHATGPT_REFRESH_TOKEN_ENV_KEY,
  providerUsesOAuth,
  SELECTABLE_OPENWIKI_PROVIDERS,
} from "../src/constants.ts";

describe("openai-chatgpt provider config", () => {
  test("is a valid, selectable provider", () => {
    expect(isValidProvider("openai-chatgpt")).toBe(true);
    expect(SELECTABLE_OPENWIKI_PROVIDERS).toContain("openai-chatgpt");
  });

  test("uses oauth authentication", () => {
    expect(getProviderAuthMethod("openai-chatgpt")).toBe("oauth");
    expect(providerUsesOAuth("openai-chatgpt")).toBe(true);
  });

  test("other providers default to api-key authentication", () => {
    expect(getProviderAuthMethod("openai")).toBe("api-key");
    expect(providerUsesOAuth("openai")).toBe(false);
    expect(providerUsesOAuth("anthropic")).toBe(false);
  });

  test("has the ChatGPT login label", () => {
    expect(getProviderLabel("openai-chatgpt")).toBe("OpenAI (ChatGPT login)");
  });

  test("mirrors the openai model options", () => {
    expect(getProviderModelOptions("openai-chatgpt")).toEqual(
      getProviderModelOptions("openai"),
    );
    expect(getProviderModelOptions("openai-chatgpt").map((m) => m.id)).toEqual([
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.5",
      "gpt-5.4-mini",
    ]);
  });

  test("its api-key env key is the access token", () => {
    expect(getProviderApiKeyEnvKey("openai-chatgpt")).toBe(
      OPENAI_CHATGPT_ACCESS_TOKEN_ENV_KEY,
    );
  });

  test("exposes the four token env key constants", () => {
    expect(OPENAI_CHATGPT_ACCESS_TOKEN_ENV_KEY).toBe(
      "OPENAI_CHATGPT_ACCESS_TOKEN",
    );
    expect(OPENAI_CHATGPT_REFRESH_TOKEN_ENV_KEY).toBe(
      "OPENAI_CHATGPT_REFRESH_TOKEN",
    );
    expect(OPENAI_CHATGPT_EXPIRES_AT_ENV_KEY).toBe("OPENAI_CHATGPT_EXPIRES_AT");
    expect(OPENAI_CHATGPT_ACCOUNT_ID_ENV_KEY).toBe("OPENAI_CHATGPT_ACCOUNT_ID");
  });
});
