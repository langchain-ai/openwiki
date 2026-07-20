import { describe, expect, test } from "vitest";
import {
  formatProviderSwitchNotice,
  getAgentCliProviderConfig,
  getDefaultModelId,
  getProviderApiKeyEnvKey,
  getProviderAuthMethod,
  getProviderLabel,
  GROK_BUILD_BINARY_ENV_KEY,
  isAgentCliProvider,
  isValidProvider,
  normalizeProvider,
  SELECTABLE_OPENWIKI_PROVIDERS,
} from "../src/constants.ts";
import { resolveStartupCommand } from "../src/startup.ts";

describe("grok-build provider config", () => {
  test("is a valid selectable agent-cli provider", () => {
    expect(isValidProvider("grok-build")).toBe(true);
    expect(normalizeProvider("GROK-BUILD")).toBe("grok-build");
    expect(SELECTABLE_OPENWIKI_PROVIDERS).toContain("grok-build");
    expect(isAgentCliProvider("grok-build")).toBe(true);
    expect(isAgentCliProvider("anthropic")).toBe(false);
  });

  test("exposes binary override and subscription label", () => {
    const config = getAgentCliProviderConfig("grok-build");

    expect(config.kind).toBe("agent-cli");
    expect(config.defaultBinary).toBe("grok");
    expect(config.binaryEnvKey).toBe(GROK_BUILD_BINARY_ENV_KEY);
    expect(config.installHint).toMatch(/grok login/i);
    expect(getProviderLabel("grok-build")).toBe("Grok Build (subscription)");
    expect(getDefaultModelId("grok-build")).toBe("grok-4.5");
  });

  test("switch notice does not mention an API key", () => {
    const notice = formatProviderSwitchNotice("grok-build");

    expect(notice).toContain("Grok Build (subscription)");
    expect(notice).toMatch(/local agent CLI login/i);
    expect(notice).not.toMatch(/API_KEY/);
  });

  test("getAgentCliProviderConfig rejects API providers", () => {
    expect(() => getAgentCliProviderConfig("openai")).toThrow(/openai/);
  });

  test("agent-cli providers have no API key env and use cli-login auth", () => {
    expect(() => getProviderApiKeyEnvKey("grok-build")).toThrow(/grok-build/);
    expect(getProviderAuthMethod("grok-build")).toBe("cli-login");
    expect(getProviderAuthMethod("openai")).toBe("api-key");
    expect(getProviderAuthMethod("openai-chatgpt")).toBe("oauth");
  });
});

describe("startup gate for grok-build", () => {
  const originalProvider = process.env.OPENWIKI_PROVIDER;
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;

  test("allows non-interactive print runs without an API key", async () => {
    process.env.OPENWIKI_PROVIDER = "grok-build";
    delete process.env.OPENROUTER_API_KEY;

    try {
      const result = await resolveStartupCommand(
        {
          kind: "run",
          exitCode: 0,
          command: "chat",
          dryRun: false,
          modelId: null,
          print: true,
          shouldStart: true,
          userMessage: "hello",
        },
        { isStdinTTY: false },
      );

      expect(result.kind).toBe("run");
    } finally {
      if (originalProvider === undefined) delete process.env.OPENWIKI_PROVIDER;
      else process.env.OPENWIKI_PROVIDER = originalProvider;

      if (originalOpenRouterKey === undefined)
        delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
    }
  });
});
