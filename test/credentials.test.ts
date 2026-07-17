import { afterEach, describe, expect, test } from "vitest";
import {
  needsCredentialSetup,
  resolveStepStatus,
} from "../src/credentials.tsx";

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

describe("resolveStepStatus", () => {
  test("the active step is current, even when it is also done", () => {
    expect(resolveStepStatus("model", "model", true)).toBe("current");
    expect(resolveStepStatus("model", "model", false)).toBe("current");
  });

  test("a completed, non-active step reads done", () => {
    expect(resolveStepStatus("model", "provider", true)).toBe("done");
    expect(resolveStepStatus("model", null, true)).toBe("done");
  });

  test("an unstarted, non-active step falls to its resting status", () => {
    expect(resolveStepStatus("model", "provider", false)).toBe("pending");
    expect(resolveStepStatus("model", null, false)).toBe("pending");
    expect(resolveStepStatus("langsmith", "provider", false, "optional")).toBe(
      "optional",
    );
  });

  test("ordering: active beats done, done beats resting", () => {
    // Active wins even over a done step (the cursor shows where you are when
    // you step back onto a completed row).
    expect(resolveStepStatus("model", "model", true)).toBe("current");
    // Done wins over an optional resting status.
    expect(resolveStepStatus("langsmith", "model", true, "optional")).toBe(
      "done",
    );
  });
});
