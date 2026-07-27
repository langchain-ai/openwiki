import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  ensureRunModeConfig,
  getInitialStep,
  getOAuthAuthorizationStatusText,
  hydrateRunModeConfig,
  needsCredentialSetup,
  needsLangSmithStep,
  nextSetupStep,
  orderedSetupSteps,
  resolveStepStatus,
} from "../src/credentials.tsx";
import type { OpenWikiOnboardingConfig } from "../src/onboarding.ts";

const ENV_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_DEFAULT_REGION",
  "AWS_REGION",
  "AWS_ROLE_ARN",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_BEARER_TOKEN_BEDROCK",
  "BEDROCK_AWS_ACCESS_KEY_ID",
  "BEDROCK_AWS_REGION",
  "BEDROCK_AWS_SECRET_ACCESS_KEY",
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

describe("needsLangSmithStep", () => {
  test("is required when neither a key nor a tracing decision is present", () => {
    // Fresh install: the optional step has never been answered.
    expect(needsLangSmithStep({})).toBe(true);
  });

  test("is not required after skipping (no key, tracing recorded as false)", () => {
    // Skipping strips the empty LANGSMITH_API_KEY but records the decision in
    // LANGCHAIN_TRACING_V2. This is the state that used to re-nag every run.
    expect(needsLangSmithStep({ LANGCHAIN_TRACING_V2: "false" })).toBe(false);
  });

  test("is not required after entering a key (tracing recorded as true)", () => {
    expect(
      needsLangSmithStep({
        LANGSMITH_API_KEY: "lsv2_real",
        LANGCHAIN_TRACING_V2: "true",
      }),
    ).toBe(false);
  });

  test("is not required when a key is present without a tracing flag", () => {
    // e.g. a shell-provided LANGSMITH_API_KEY: don't nag someone who has a key.
    expect(needsLangSmithStep({ LANGSMITH_API_KEY: "lsv2_from_shell" })).toBe(
      false,
    );
  });
});

describe("run-mode wiki brief isolation", () => {
  const personalConfig: OpenWikiOnboardingConfig = {
    modeId: "personal",
    modeName: "Personal",
    sourceInstances: [],
    sources: {},
    templateId: "personal",
    templateName: "Personal",
    version: 1,
    wikiGoal: "Track my personal projects and commitments.",
  };

  test("clears the global personal brief when switching to code mode", () => {
    expect(ensureRunModeConfig(personalConfig, "code")).toMatchObject({
      modeId: "code",
      templateId: "code",
      wikiGoal: undefined,
    });
  });

  test("does not inherit a personal brief for a new code repository", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "openwiki-code-mode-"));

    try {
      const codeConfig = {
        ...personalConfig,
        modeId: "code",
        modeName: "Code",
        templateId: "code",
        templateName: "Code",
      };

      await expect(
        hydrateRunModeConfig(codeConfig, "code", repo),
      ).resolves.toMatchObject({ wikiGoal: undefined });
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("uses a repository-specific code brief when present", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "openwiki-code-mode-"));
    const instructionsDir = path.join(repo, "openwiki");

    try {
      await mkdir(instructionsDir);
      await writeFile(
        path.join(instructionsDir, "INSTRUCTIONS.md"),
        "Document this repository's architecture.\n",
      );

      await expect(
        hydrateRunModeConfig(personalConfig, "code", repo),
      ).resolves.toMatchObject({
        wikiGoal: "Document this repository's architecture.",
      });
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("retains the personal brief in personal mode", async () => {
    await expect(
      hydrateRunModeConfig(personalConfig, "personal", "/unused"),
    ).resolves.toBe(personalConfig);
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

  test("bedrock delegates AWS credentials and only prompts for region", () => {
    delete process.env.BEDROCK_AWS_ACCESS_KEY_ID;
    delete process.env.BEDROCK_AWS_SECRET_ACCESS_KEY;

    expect(orderedSetupSteps("bedrock", "code", false)).toEqual([
      "provider",
      "region",
      "model",
      "langsmith",
      "code-repo-confirm",
    ]);
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

  test("bedrock accepts ambient OIDC credentials and a standard AWS region", () => {
    process.env.OPENWIKI_PROVIDER = "bedrock";
    process.env.AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/openwiki";
    process.env.AWS_WEB_IDENTITY_TOKEN_FILE = "/var/run/secrets/aws/token";
    process.env.AWS_REGION = "us-east-1";
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_SESSION_TOKEN;
    delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    delete process.env.BEDROCK_AWS_ACCESS_KEY_ID;
    delete process.env.BEDROCK_AWS_SECRET_ACCESS_KEY;
    delete process.env.BEDROCK_AWS_REGION;
    delete process.env.OPENWIKI_MODEL_ID;

    expect(getInitialStep(null, "bedrock")).toBe("model");
  });

  test("bedrock routes incomplete legacy credentials to the repair gate", () => {
    process.env.OPENWIKI_PROVIDER = "bedrock";
    process.env.BEDROCK_AWS_ACCESS_KEY_ID = "partial-access";
    delete process.env.BEDROCK_AWS_SECRET_ACCESS_KEY;
    process.env.AWS_REGION = "us-east-1";
    process.env.OPENWIKI_MODEL_ID = "anthropic.claude-sonnet-5";
    process.env.LANGSMITH_API_KEY = "lsv2_placeholder";

    expect(getInitialStep(null, "bedrock")).toBe("region");
  });

  test("bedrock routes incomplete standard credentials to the repair gate", () => {
    process.env.OPENWIKI_PROVIDER = "bedrock";
    delete process.env.BEDROCK_AWS_ACCESS_KEY_ID;
    delete process.env.BEDROCK_AWS_SECRET_ACCESS_KEY;
    process.env.AWS_ACCESS_KEY_ID = "partial-access";
    delete process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_REGION = "us-east-1";
    process.env.OPENWIKI_MODEL_ID = "anthropic.claude-sonnet-5";
    process.env.LANGSMITH_API_KEY = "lsv2_placeholder";

    expect(getInitialStep(null, "bedrock")).toBe("region");
  });
});

describe("nextSetupStep", () => {
  test("walks forward through the spine", () => {
    expect(nextSetupStep("provider", "openai", "code", false)).toBe("api-key");
    expect(nextSetupStep("api-key", "openai", "code", false)).toBe("model");
  });

  test("moves from bedrock provider selection directly to region", () => {
    delete process.env.BEDROCK_AWS_ACCESS_KEY_ID;
    delete process.env.BEDROCK_AWS_SECRET_ACCESS_KEY;

    expect(nextSetupStep("provider", "bedrock", "code", false)).toBe("region");
  });

  test("no-op at the end and for null", () => {
    expect(nextSetupStep("code-repo-confirm", "openai", "code", false)).toBe(
      null,
    );
    expect(nextSetupStep(null, "openai", "code", false)).toBe(null);
  });
});

describe("getOAuthAuthorizationStatusText", () => {
  test("uses a provider-specific fallback command when the URL is not copied", () => {
    expect(
      getOAuthAuthorizationStatusText({
        authProvider: "gmail",
        copiedToClipboard: false,
      }),
    ).toContain("openwiki auth gmail");
  });

  test("does not expose the raw authorization URL in fallback text", () => {
    const rawUrl = "https://accounts.google.com/o/oauth2/v2/auth?state=abc";

    expect(
      getOAuthAuthorizationStatusText({
        authProvider: "gmail",
        copiedToClipboard: false,
      }),
    ).not.toContain(rawUrl);
  });
});
