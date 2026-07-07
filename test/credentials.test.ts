import { afterEach, describe, expect, test } from "vitest";
import { needsCredentialSetup } from "../src/credentials.tsx";

const ENV_KEYS = [
  "LANGSMITH_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENWIKI_MODEL_ID",
  "OPENWIKI_PROVIDER",
] as const;

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const originalValue = originalEnv.get(key);

    if (originalValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalValue;
    }
  }
});

describe("needsCredentialSetup", () => {
  test("requires provider setup for an invalid configured provider", () => {
    process.env.OPENWIKI_PROVIDER = "bogus";
    process.env.OPENROUTER_API_KEY = "sk-or-v1-placeholder";
    process.env.OPENWIKI_MODEL_ID = "z-ai/glm-5.2";
    process.env.LANGSMITH_API_KEY = "lsv2_placeholder";

    expect(needsCredentialSetup()).toBe(true);
  });
});
