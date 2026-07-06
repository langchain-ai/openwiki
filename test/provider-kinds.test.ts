import { describe, expect, test } from "vitest";
import {
  CLAUDE_CODE_BINARY_ENV_KEY,
  getAgentCliProviderConfig,
  getDefaultModelId,
  getProviderApiKeyEnvKey,
  getProviderLabel,
  isAgentCliProvider,
  isValidModelId,
  normalizeProvider,
  providerRequiresBaseUrl,
  resolveProviderBaseUrl,
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

  test("credential diagnostics include the claude-code binary override", async () => {
    const diagnostics = await getCredentialDiagnostics();

    expect(diagnostics.map((diagnostic) => diagnostic.key)).toContain(
      CLAUDE_CODE_BINARY_ENV_KEY,
    );
  });
});
