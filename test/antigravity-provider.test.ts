import { describe, expect, test } from "vitest";
import {
  ANTIGRAVITY_BINARY_ENV_KEY,
  formatProviderSwitchNotice,
  getAgentCliProviderConfig,
  getDefaultModelId,
  getProviderApiKeyEnvKey,
  getProviderAuthMethod,
  getProviderLabel,
  isAgentCliProvider,
  isValidModelId,
  isValidProvider,
  normalizeProvider,
  SELECTABLE_OPENWIKI_PROVIDERS,
} from "../src/constants.ts";
import { resolveStartupCommand } from "../src/startup.ts";

describe("antigravity provider config", () => {
  test("is a valid selectable agent-cli provider", () => {
    expect(isValidProvider("antigravity")).toBe(true);
    expect(normalizeProvider("ANTIGRAVITY")).toBe("antigravity");
    expect(SELECTABLE_OPENWIKI_PROVIDERS).toContain("antigravity");
    expect(isAgentCliProvider("antigravity")).toBe(true);
    expect(isAgentCliProvider("openai")).toBe(false);
  });

  test("exposes binary override and subscription label", () => {
    const config = getAgentCliProviderConfig("antigravity");

    expect(config.kind).toBe("agent-cli");
    expect(config.defaultBinary).toBe("agy");
    expect(config.binaryEnvKey).toBe(ANTIGRAVITY_BINARY_ENV_KEY);
    expect(config.installHint).toMatch(/agy/i);
    expect(getProviderLabel("antigravity")).toBe(
      "Antigravity (subscription)",
    );
    expect(getDefaultModelId("antigravity")).toBe(
      "Gemini 3.5 Flash (Medium)",
    );
    expect(isValidModelId(getDefaultModelId("antigravity"))).toBe(true);
  });

  test("switch notice does not mention an API key", () => {
    const notice = formatProviderSwitchNotice("antigravity");

    expect(notice).toContain("Antigravity (subscription)");
    expect(notice).toMatch(/local agent CLI login/i);
    expect(notice).not.toMatch(/API_KEY/);
  });

  test("agent-cli providers have no API key env and use cli-login auth", () => {
    expect(() => getProviderApiKeyEnvKey("antigravity")).toThrow(
      /antigravity/,
    );
    expect(getProviderAuthMethod("antigravity")).toBe("cli-login");
  });
});

describe("startup gate for antigravity", () => {
  const originalProvider = process.env.OPENWIKI_PROVIDER;
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;

  test("allows non-interactive print runs without an API key", async () => {
    process.env.OPENWIKI_PROVIDER = "antigravity";
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
