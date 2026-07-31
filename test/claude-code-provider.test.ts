import { describe, expect, test } from "vitest";
import {
  getProviderApiKeyEnvKey,
  getProviderAuthMethod,
  getProviderExternalCliAuthAdapter,
  getProviderModelOptions,
  providerRequiresApiKey,
  providerUsesExternalCliAuth,
  providerUsesResponsesApi,
  SELECTABLE_OPENWIKI_PROVIDERS,
} from "../src/constants.ts";

describe("Claude Code provider config", () => {
  test("authenticates through the Claude Code CLI rather than a key", () => {
    expect(getProviderAuthMethod("claude-code")).toBe("external-cli");
    expect(providerUsesExternalCliAuth("claude-code")).toBe(true);
    expect(getProviderExternalCliAuthAdapter("claude-code")).toBe("claude-cli");
  });

  test("is keyless: no API key env var and none required", () => {
    // The whole point of the provider is serving users who cannot create an
    // API key, so introducing one here would defeat it.
    expect(getProviderApiKeyEnvKey("claude-code")).toBeUndefined();
    expect(providerRequiresApiKey("claude-code")).toBe(false);
  });

  test("is selectable during onboarding", () => {
    expect(SELECTABLE_OPENWIKI_PROVIDERS).toContain("claude-code");
  });

  test("offers the frontier Claude models the CLI can serve", () => {
    const ids = getProviderModelOptions("claude-code").map((model) => model.id);

    expect(ids).toContain("claude-opus-5");
    expect(ids).toContain("claude-fable-5");
  });

  test("offers Claude model ids in canonical API form", () => {
    const ids = getProviderModelOptions("claude-code").map((model) => model.id);

    expect(ids.length).toBeGreaterThan(0);
    // Copilot lists dotted ids ("claude-opus-4.8"); the CLI takes the canonical
    // dashed form, so a copy/paste between the two would silently 404.
    for (const id of ids) {
      expect(id).toMatch(/^claude-[a-z0-9-]+$/u);
      expect(id).not.toContain(".");
    }
  });

  test("never routes through the OpenAI Responses API", () => {
    expect(providerUsesResponsesApi("claude-code", "claude-opus-5")).toBe(
      false,
    );
  });
});
