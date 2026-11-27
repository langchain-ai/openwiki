import { describe, expect, test } from "vitest";
import {
  COPILOT_API_KEY_ENV_KEY,
  getProviderAuthMethod,
  getProviderExternalCliAuthAdapter,
  providerRequiresApiKey,
  providerUsesExternalCliAuth,
  providerUsesResponsesApi,
  providerUsesStreaming,
} from "../../src/config/constants.ts";

describe("GitHub Copilot provider config", () => {
  test("uses the generic external CLI authentication strategy", () => {
    expect(getProviderAuthMethod("copilot")).toBe("external-cli");
    expect(providerUsesExternalCliAuth("copilot")).toBe(true);
    expect(getProviderExternalCliAuthAdapter("copilot")).toBe("github-cli");
    expect(providerRequiresApiKey("copilot")).toBe(false);
  });

  test("keeps COPILOT_API_KEY as an explicit CI fallback", () => {
    expect(COPILOT_API_KEY_ENV_KEY).toBe("COPILOT_API_KEY");
  });

  test.each([
    "gpt-5",
    "gpt-5.5",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-6",
    "gpt-6-astra",
    "gpt-6-luna",
    "gpt-6-sol",
    "gpt-6.1-sol",
    "gpt-6.1-terra",
    "gpt-6.2-astra",
    "gpt-6.2-sol",
    "gpt-9",
    "gpt-10",
    "gpt-100",
  ])("uses the Responses API for Copilot model %s", (modelId) => {
    expect(providerUsesResponsesApi("copilot", modelId)).toBe(true);
  });

  test.each(["gpt-4.1", "gpt-4o", "claude-sonnet-5", "gemini-2.5-pro"])(
    "keeps Copilot model %s on chat completions",
    (modelId) => {
      expect(providerUsesResponsesApi("copilot", modelId)).toBe(false);
    },
  );

  test.each(["gpt-05", "gpt-6foo", "gpt-10foo", "custom-gpt-6"])(
    "does not match malformed or prefixed GPT model ID %s",
    (modelId) => {
      expect(providerUsesResponsesApi("copilot", modelId)).toBe(false);
    },
  );

  test("always forces streaming transport for all Copilot models", () => {
    // The Copilot API rejects non-streaming requests for Claude and Gemini
    // models, causing repository workers to exit without calling submit_plan
    // or submit_page. All Copilot models must use the streaming transport.
    expect(providerUsesStreaming("copilot")).toBe(true);
  });
});
