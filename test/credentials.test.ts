import { afterEach, describe, expect, test } from "vitest";
import {
  getInitialStep,
  needsCredentialSetup,
  nextSetupStep,
  orderedSetupSteps,
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

describe("orderedSetupSteps", () => {
  test("openai (code mode): provider, key, model, langsmith, then the tail", () => {
    expect(orderedSetupSteps("openai", "code", false)).toEqual([
      "provider",
      "api-key",
      "model",
      "langsmith",
      "code-repo-confirm",
    ]);
  });

  test("run-mode is first only when mode selection is allowed", () => {
    expect(orderedSetupSteps("openai", "code", true)[0]).toBe("run-mode");
    expect(orderedSetupSteps("openai", "code", false)).not.toContain(
      "run-mode",
    );
  });

  test("bedrock adds secret-key and region before model", () => {
    const spine = orderedSetupSteps("bedrock", "code", false);
    expect(spine).toContain("secret-key");
    expect(spine).toContain("region");
    expect(spine.indexOf("secret-key")).toBeLessThan(spine.indexOf("model"));
    expect(spine.indexOf("region")).toBeLessThan(spine.indexOf("model"));
  });

  test("personal mode ends at langsmith with no template chooser or code tail", () => {
    // The template is fixed by the run mode in personal mode, so the spine
    // skips the redundant Code/Personal chooser and walks straight into the
    // wiki brief after langsmith.
    const spine = orderedSetupSteps("openai", "personal", false);
    expect(spine[spine.length - 1]).toBe("langsmith");
    expect(spine).not.toContain("template");
    expect(spine).not.toContain("code-repo-confirm");
  });

  test("the spine includes applicable steps regardless of env (reachability)", () => {
    // api-key is present even when a key is already set, so navigation can
    // still reach and re-edit it.
    expect(orderedSetupSteps("openai", "code", false)).toContain("api-key");
  });
});

describe("getInitialStep", () => {
  test("walkAll starts at the first spine step regardless of configuration", () => {
    // walkAll short-circuits the skip-waterfall, so it never returns null even
    // when everything would otherwise be satisfied.
    expect(getInitialStep(null, "openai", undefined, "code", false, true)).toBe(
      "provider",
    );
    expect(
      getInitialStep(null, "bedrock", undefined, "code", false, true),
    ).toBe("provider");
  });

  test("walkAll returns run-mode first when mode selection is allowed", () => {
    expect(getInitialStep(null, "openai", undefined, "code", true, true)).toBe(
      "run-mode",
    );
  });
});

describe("nextSetupStep", () => {
  test("walks forward through the spine", () => {
    expect(nextSetupStep("provider", "openai", "code", false)).toBe("api-key");
    expect(nextSetupStep("api-key", "openai", "code", false)).toBe("model");
  });

  test("no-op at the end and for null", () => {
    expect(nextSetupStep("code-repo-confirm", "openai", "code", false)).toBe(
      null,
    );
    expect(nextSetupStep(null, "openai", "code", false)).toBe(null);
  });
});
