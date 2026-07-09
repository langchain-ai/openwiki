import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  getInitialStep,
  getNextStepAfterAgentCheck,
  getNextStepAfterModel,
  getNextStepAfterProvider,
  needsCredentialSetup,
} from "../src/credentials-flow.ts";

const ENV_KEYS = [
  "OPENWIKI_PROVIDER",
  "OPENWIKI_MODEL_ID",
  "LANGSMITH_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("agent-cli setup flow", () => {
  test("claude-code needs setup only until provider and model are saved", () => {
    process.env.OPENWIKI_PROVIDER = "claude-code";
    expect(needsCredentialSetup(null)).toBe(true);

    process.env.OPENWIKI_MODEL_ID = "default";
    expect(needsCredentialSetup(null)).toBe(false);
  });

  test("api providers still require key and LangSmith decisions", () => {
    process.env.OPENWIKI_PROVIDER = "anthropic";
    process.env.OPENWIKI_MODEL_ID = "claude-sonnet-5";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(needsCredentialSetup(null)).toBe(true); // LangSmith undecided

    process.env.LANGSMITH_API_KEY = "";
    expect(needsCredentialSetup(null)).toBe(false);
  });

  test("provider selection routes claude-code to the agent check", () => {
    expect(getNextStepAfterProvider("claude-code", null)).toBe("agent-check");
    expect(getNextStepAfterProvider("anthropic", null)).toBe("api-key");
  });

  test("agent check advances to model selection when the model is unset", () => {
    expect(getNextStepAfterAgentCheck("claude-code", null)).toBe("model");
    expect(getNextStepAfterAgentCheck("claude-code", "opus")).toBe(null);
  });

  test("initial step for a configured claude-code without a model is agent-check", () => {
    process.env.OPENWIKI_PROVIDER = "claude-code";
    expect(getInitialStep(null, "claude-code")).toBe("agent-check");

    process.env.OPENWIKI_MODEL_ID = "default";
    expect(getInitialStep(null, "claude-code")).toBe(null);
  });

  test("model step skips LangSmith for agent-cli providers", () => {
    expect(getNextStepAfterModel("claude-code")).toBe(null);
    expect(getNextStepAfterModel("openrouter")).toBe("langsmith");
  });
});
