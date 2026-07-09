import { describe, expect, test } from "vitest";
import {
  CLAUDE_CODE_BINARY_ENV_KEY,
  formatProviderSwitchNotice,
  getAgentCliProviderConfig,
  getDefaultModelId,
  getProviderApiKeyEnvKey,
  getProviderLabel,
  isAgentCliProvider,
  isValidModelId,
  normalizeProvider,
  providerRequiresBaseUrl,
  resolveProviderBaseUrl,
  SELECTABLE_OPENWIKI_PROVIDERS,
} from "../src/constants.ts";
import { getCredentialDiagnostics } from "../src/env.ts";

describe("agent-cli provider kinds", () => {
  test("claude-code is a valid provider id", () => {
    expect(normalizeProvider("claude-code")).toBe("claude-code");
    expect(normalizeProvider("CLAUDE-CODE")).toBe("claude-code");
  });

  test("isAgentCliProvider distinguishes provider kinds", () => {
    expect(isAgentCliProvider("claude-code")).toBe(true);
    expect(isAgentCliProvider("anthropic")).toBe(false);
    expect(isAgentCliProvider("openrouter")).toBe(false);
    expect(isAgentCliProvider("openai-compatible")).toBe(false);
  });

  test("agent-cli config exposes binary, override key, and install hint", () => {
    const config = getAgentCliProviderConfig("claude-code");

    expect(config.kind).toBe("agent-cli");
    expect(config.defaultBinary).toBe("claude");
    expect(config.binaryEnvKey).toBe(CLAUDE_CODE_BINARY_ENV_KEY);
    expect(config.installHint).toContain("claude");
  });

  test("getAgentCliProviderConfig rejects API providers", () => {
    expect(() => getAgentCliProviderConfig("openai")).toThrow(/openai/);
  });

  test("model options start with the subscription default", () => {
    expect(getDefaultModelId("claude-code")).toBe("default");
    expect(isValidModelId("default")).toBe(true);
  });

  test("api-key helper rejects agent-cli providers", () => {
    expect(() => getProviderApiKeyEnvKey("claude-code")).toThrow(/claude-code/);
  });

  test("base URL helpers treat agent-cli providers as endpoint-free", () => {
    expect(providerRequiresBaseUrl("claude-code")).toBe(false);
    expect(resolveProviderBaseUrl("claude-code")).toBeUndefined();
  });

  test("label reads as a subscription provider", () => {
    expect(getProviderLabel("claude-code")).toBe("Claude Code (subscription)");
  });

  test("claude-code is selectable in the provider menu", () => {
    expect(SELECTABLE_OPENWIKI_PROVIDERS).toContain("claude-code");
  });

  test("credential diagnostics include the claude-code binary override", async () => {
    const diagnostics = await getCredentialDiagnostics();

    expect(diagnostics.map((diagnostic) => diagnostic.key)).toContain(
      CLAUDE_CODE_BINARY_ENV_KEY,
    );
  });
});

describe("formatProviderSwitchNotice", () => {
  test("api providers get the API-key reminder", () => {
    const notice = formatProviderSwitchNotice("anthropic");

    expect(notice).toContain("Provider switched to Anthropic");
    expect(notice).toContain(getDefaultModelId("anthropic"));
    expect(notice).toContain("Ensure ANTHROPIC_API_KEY is set.");
  });

  test("agent-cli providers do not throw and mention the CLI login instead of a key", () => {
    const notice = formatProviderSwitchNotice("claude-code");

    expect(notice).toContain("Provider switched to Claude Code (subscription)");
    expect(notice).toContain(getDefaultModelId("claude-code"));
    expect(notice).not.toContain("API key");
    expect(notice).not.toContain("_API_KEY");
    expect(notice).toContain("login");
  });
});
