import { describe, expect, test } from "vitest";
import {
  COPILOT_API_KEY_ENV_KEY,
  getProviderAuthMethod,
  getProviderExternalCliAuthAdapter,
  providerRequiresApiKey,
  providerUsesExternalCliAuth,
  providerUsesResponsesApi,
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

  test("uses the Responses API only for Copilot GPT-5 models", () => {
    expect(providerUsesResponsesApi("copilot", "gpt-5.5")).toBe(true);
    expect(providerUsesResponsesApi("copilot", "claude-sonnet-5")).toBe(false);
  });
});
