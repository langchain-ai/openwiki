import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  getProviderApiKeyEnvKey,
  getProviderBaseUrlEnvKey,
  getProviderProjectEnvKey,
  getProviderRegionEnvKey,
  getProviderSecretKeyEnvKey,
  AWS_ACCESS_KEY_ID_ENV_KEY,
  AWS_BEARER_TOKEN_BEDROCK_ENV_KEY,
  AWS_SECRET_ACCESS_KEY_ENV_KEY,
} from "../../../src/config/constants.ts";
import { createEmptyOnboardingConfig } from "../../../src/setup/onboarding.ts";
import type { OpenWikiOnboardingConfig } from "../../../src/setup/onboarding.ts";
import {
  credentialStep,
  ensureRunModeConfig,
  getConfigModeId,
  getConfigModeName,
  getInitialStep,
  getLangsmithRegionLabel,
  getLangsmithRegionSelectionIndex,
  getRunModeName,
  getRunModeSelectionIndex,
  getSourceOption,
  getWizardManagedEnvKeys,
  hasValidStoredToken,
  hydrateRunModeConfig,
  isBaseUrlConfigured,
  isCodeMode,
  isCredentialConfigured,
  isRegionConfigured,
  isSecretKeyConfigured,
  needsAwsCredentialRepair,
  needsBaseUrlStep,
  needsCredentialSetup,
  needsCredentialStep,
  needsGcpProjectStep,
  needsLangSmithStep,
  needsRegionStep,
  needsSecretKeyStep,
  nextSetupStep,
  orderedSetupSteps,
  resolveStepStatus,
} from "../../../src/setup/credentials/steps.ts";

// hydrateRunModeConfig is the only function here that reads the filesystem
// (repository wiki instructions). Stub just that one onboarding export so the
// code-mode branch is deterministic; every other onboarding helper stays real.
vi.mock("../../../src/setup/onboarding.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/setup/onboarding.ts")>();
  return {
    ...actual,
    readRepositoryWikiInstructions: () => Promise.resolve("hydrated repo goal"),
  };
});

/**
 * The applicable setup spine per provider in personal mode with no mode chooser.
 * This is a pure function of the provider (it never reads the environment), so
 * these sequences are the wizard's static decision table for every provider.
 */
const SPINE_BY_PROVIDER: Record<string, string[]> = {
  openai: ["provider", "api-key", "model", "langsmith"],
  "openai-chatgpt": ["provider", "oauth-login", "model", "langsmith"],
  anthropic: ["provider", "api-key", "model", "langsmith"],
  copilot: ["provider", "external-cli-auth", "model", "langsmith"],
  gemini: ["provider", "api-key", "model", "langsmith"],
  "gemini-enterprise": [
    "provider",
    "gcp-project",
    "gcp-location",
    "model",
    "langsmith",
  ],
  openrouter: ["provider", "api-key", "model", "langsmith"],
  "openai-compatible": [
    "provider",
    "api-key",
    "base-url",
    "model",
    "langsmith",
  ],
  bedrock: ["provider", "region", "model", "langsmith"],
  fireworks: ["provider", "api-key", "model", "langsmith"],
  baseten: ["provider", "api-key", "model", "langsmith"],
  nebius: ["provider", "api-key", "model", "langsmith"],
  nvidia: ["provider", "api-key", "model", "langsmith"],
};

/** Every environment key any test in this file reads or writes. */
const MANAGED_KEYS = [
  "OPENWIKI_PROVIDER",
  "OPENWIKI_MODEL_ID",
  "LANGSMITH_API_KEY",
  "LANGCHAIN_TRACING_V2",
  "OPENAI_CHATGPT_ACCESS_TOKEN",
  "OPENAI_CHATGPT_REFRESH_TOKEN",
  "OPENAI_CHATGPT_ACCOUNT_ID",
  "OPENAI_CHATGPT_EXPIRES_AT",
  getProviderApiKeyEnvKey("openai"),
  getProviderApiKeyEnvKey("bedrock"),
  getProviderSecretKeyEnvKey("bedrock"),
  getProviderRegionEnvKey("bedrock"),
  getProviderProjectEnvKey("gemini-enterprise"),
  getProviderBaseUrlEnvKey("openai-compatible"),
  AWS_ACCESS_KEY_ID_ENV_KEY,
  AWS_SECRET_ACCESS_KEY_ENV_KEY,
  AWS_BEARER_TOKEN_BEDROCK_ENV_KEY,
].filter((key): key is string => key !== undefined);

let snapshot: Record<string, string | undefined>;

function set(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

/** Builds an onboarding config from the empty base with the given overrides. */
function config(
  overrides: Partial<OpenWikiOnboardingConfig> = {},
): OpenWikiOnboardingConfig {
  return { ...createEmptyOnboardingConfig(), ...overrides };
}

beforeEach(() => {
  snapshot = {};
  for (const key of MANAGED_KEYS) {
    snapshot[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of MANAGED_KEYS) {
    set(key, snapshot[key]);
  }
});

describe("orderedSetupSteps", () => {
  for (const [provider, spine] of Object.entries(SPINE_BY_PROVIDER)) {
    test(`walks ${provider} in the expected order`, () => {
      expect(orderedSetupSteps(provider as never, "personal", false)).toEqual(
        spine,
      );
    });
  }

  test("prepends the run-mode chooser when mode selection is allowed", () => {
    expect(orderedSetupSteps("openai", "personal", true)).toEqual([
      "run-mode",
      ...SPINE_BY_PROVIDER.openai,
    ]);
  });

  test("appends repo confirmation in code mode", () => {
    expect(orderedSetupSteps("openai", "code", false)).toEqual([
      ...SPINE_BY_PROVIDER.openai,
      "code-repo-confirm",
    ]);
  });

  test("emits the keyless provider's project credential exactly once", () => {
    // gemini-enterprise's primary credential IS the gcp-project step, so it must
    // not also be appended by the later project-key branch.
    const steps = orderedSetupSteps("gemini-enterprise", "personal", false);
    expect(steps.filter((step) => step === "gcp-project")).toHaveLength(1);
  });
});

describe("credentialStep", () => {
  test.each([
    ["openai-chatgpt", "oauth-login"],
    ["bedrock", null],
    ["copilot", "external-cli-auth"],
    ["openai", "api-key"],
    ["gemini-enterprise", "gcp-project"],
  ])("maps %s to its primary credential step", (provider, expected) => {
    expect(credentialStep(provider as never)).toBe(expected);
  });
});

describe("nextSetupStep", () => {
  test("returns the following step in the spine", () => {
    expect(nextSetupStep("provider", "openai", "personal", false)).toBe(
      "api-key",
    );
    expect(nextSetupStep("model", "openai", "code", false)).toBe("langsmith");
    expect(nextSetupStep("langsmith", "openai", "code", false)).toBe(
      "code-repo-confirm",
    );
  });

  test("returns null for the last step, an off-spine step, or a null step", () => {
    expect(nextSetupStep("langsmith", "openai", "personal", false)).toBeNull();
    expect(nextSetupStep("region", "openai", "personal", false)).toBeNull();
    expect(nextSetupStep(null, "openai", "personal", false)).toBeNull();
  });
});

describe("getWizardManagedEnvKeys", () => {
  test("lists an api-key provider's managed keys with no undefined entries", () => {
    const keys = getWizardManagedEnvKeys("openai");

    expect(keys).toContain("OPENWIKI_PROVIDER");
    expect(keys).toContain("OPENWIKI_MODEL_ID");
    expect(keys).toContain("LANGSMITH_API_KEY");
    expect(keys).toContain(getProviderApiKeyEnvKey("openai"));
    expect(keys.every((key) => typeof key === "string")).toBe(true);
  });

  test("drops the absent api key for a keyless provider but keeps its project", () => {
    const keys = getWizardManagedEnvKeys("gemini-enterprise");

    expect(keys).toContain(getProviderProjectEnvKey("gemini-enterprise"));
    // gemini-enterprise has no api-key env var, so the filtered list omits it.
    expect(keys).not.toContain(undefined);
  });
});

describe("resolveStepStatus", () => {
  test("marks the active step current before anything else", () => {
    expect(resolveStepStatus("api-key", "api-key", false)).toBe("current");
  });

  test("marks a finished, non-active step done", () => {
    expect(resolveStepStatus("api-key", "provider", true)).toBe("done");
  });

  test("falls back to the resting status for an unreached step", () => {
    expect(resolveStepStatus("api-key", "provider", false)).toBe("pending");
    expect(resolveStepStatus("api-key", "provider", false, "optional")).toBe(
      "optional",
    );
  });
});

describe("needsLangSmithStep", () => {
  test("is unanswered only when neither a key nor a tracing decision exists", () => {
    expect(needsLangSmithStep({})).toBe(true);
    expect(needsLangSmithStep({ LANGSMITH_API_KEY: "lsv2_key" })).toBe(false);
    expect(needsLangSmithStep({ LANGCHAIN_TRACING_V2: "false" })).toBe(false);
  });
});

describe("hasValidStoredToken", () => {
  const future = String(Date.now() + 60 * 60 * 1000);
  const past = String(Date.now() - 60 * 60 * 1000);

  function tokenEnv(expiresAt: string): NodeJS.ProcessEnv {
    return {
      OPENAI_CHATGPT_ACCESS_TOKEN: "access-token",
      OPENAI_CHATGPT_REFRESH_TOKEN: "refresh-token",
      OPENAI_CHATGPT_ACCOUNT_ID: "acct_1",
      OPENAI_CHATGPT_EXPIRES_AT: expiresAt,
    };
  }

  test("is false with no tokens and true with a complete, unexpired set", () => {
    expect(hasValidStoredToken({})).toBe(false);
    expect(hasValidStoredToken(tokenEnv(future))).toBe(true);
  });

  test("is false once the stored token has expired", () => {
    expect(hasValidStoredToken(tokenEnv(past))).toBe(false);
  });
});

describe("onboarding-config accessors", () => {
  test("getConfigModeId prefers modeId then falls back to templateId", () => {
    expect(getConfigModeId(config({ modeId: "code" }))).toBe("code");
    expect(getConfigModeId(config({ templateId: "personal" }))).toBe(
      "personal",
    );
    expect(getConfigModeId(config())).toBeUndefined();
  });

  test("getConfigModeName prefers modeName then falls back to templateName", () => {
    expect(getConfigModeName(config({ modeName: "Code" }))).toBe("Code");
    expect(getConfigModeName(config({ templateName: "Personal" }))).toBe(
      "Personal",
    );
    expect(getConfigModeName(config())).toBeUndefined();
  });

  test("isCodeMode is true only for the code template", () => {
    expect(isCodeMode(config({ modeId: "code" }))).toBe(true);
    expect(isCodeMode(config({ modeId: "personal" }))).toBe(false);
  });
});

describe("run-mode and region label getters", () => {
  test("getRunModeName resolves known modes and echoes unknown ones", () => {
    expect(getRunModeName("code")).toBe("Code");
    expect(getRunModeName("personal")).toBe("Personal");
    expect(getRunModeName("bogus" as never)).toBe("bogus");
  });

  test("getRunModeSelectionIndex maps modes to their menu index, defaulting to 0", () => {
    expect(getRunModeSelectionIndex("personal")).toBe(0);
    expect(getRunModeSelectionIndex("code")).toBe(1);
    expect(getRunModeSelectionIndex("bogus" as never)).toBe(0);
  });

  test("langsmith region getters resolve label and index, defaulting to US", () => {
    expect(getLangsmithRegionSelectionIndex("us")).toBe(0);
    expect(getLangsmithRegionSelectionIndex("eu")).toBe(1);
    expect(getLangsmithRegionSelectionIndex("bogus" as never)).toBe(0);
    expect(getLangsmithRegionLabel("us")).toBe(
      "US (https://api.smith.langchain.com)",
    );
    expect(getLangsmithRegionLabel("bogus" as never)).toBe("bogus");
  });

  test("getSourceOption resolves a known source and falls back to the first", () => {
    expect(getSourceOption("langsmith").id).toBe("langsmith");
    expect(getSourceOption("git-repo").id).toBe("git-repo");
    expect(getSourceOption("bogus" as never)).toBe(getSourceOption("git-repo"));
  });
});

describe("ensureRunModeConfig", () => {
  test("returns the config untouched when the mode already matches (personal)", () => {
    const personal = config({ modeId: "personal", modeName: "Personal" });
    expect(ensureRunModeConfig(personal, "personal")).toBe(personal);
  });

  test("strips the personal wiki goal when switching an already-code config", () => {
    const code = config({ modeId: "code", wikiGoal: "leftover goal" });
    const result = ensureRunModeConfig(code, "code");

    expect(result).not.toBe(code);
    expect(result.wikiGoal).toBeUndefined();
    expect(result.modeId).toBe("code");
  });

  test("applies the template fields when the mode changes", () => {
    const personal = config({ modeId: "personal", wikiGoal: "keep me" });
    const result = ensureRunModeConfig(personal, "code");

    expect(result.modeId).toBe("code");
    expect(result.modeName).toBe("Code");
    expect(result.templateId).toBe("code");
    expect(result.templateName).toBe("Code");
    expect(result.wikiGoal).toBeUndefined();
  });

  test("returns the config unchanged for an unknown target mode", () => {
    const code = config({ modeId: "code" });
    expect(ensureRunModeConfig(code, "bogus" as never)).toBe(code);
  });
});

describe("hydrateRunModeConfig", () => {
  test("returns the config unchanged outside code mode", async () => {
    const personal = config({ modeId: "personal" });
    await expect(
      hydrateRunModeConfig(personal, "personal", "/repo"),
    ).resolves.toBe(personal);
  });

  test("loads the repository wiki goal in code mode", async () => {
    const result = await hydrateRunModeConfig(config(), "code", "/repo");
    expect(result.wikiGoal).toBe("hydrated repo goal");
  });
});

describe("getInitialStep static branches", () => {
  test("walkAll starts at the first applicable step regardless of environment", () => {
    expect(getInitialStep(null, "openai", undefined, "code", false, true)).toBe(
      "provider",
    );
  });

  test("mode selection wins before any credential probing", () => {
    expect(getInitialStep(null, "openai", undefined, "code", true, false)).toBe(
      "run-mode",
    );
  });

  test("walkAll with mode selection starts at run-mode", () => {
    expect(getInitialStep(null, "openai", undefined, "code", true, true)).toBe(
      "run-mode",
    );
  });
});

describe("environment-driven credential predicates", () => {
  test("bedrock needs the region step until a region is set", () => {
    const regionKey = getProviderRegionEnvKey("bedrock");
    if (!regionKey) throw new Error("bedrock must define a region env key");

    expect(needsRegionStep("bedrock")).toBe(true);
    expect(isRegionConfigured("bedrock")).toBe(false);

    set(regionKey, "us-east-1");
    expect(needsRegionStep("bedrock")).toBe(false);
    expect(isRegionConfigured("bedrock")).toBe(true);
  });

  test("openai-compatible needs the base-url step until one is set", () => {
    const baseUrlKey = getProviderBaseUrlEnvKey("openai-compatible");
    if (!baseUrlKey)
      throw new Error("openai-compatible must define a base url");

    expect(needsBaseUrlStep("openai-compatible")).toBe(true);
    expect(isBaseUrlConfigured("openai-compatible")).toBe(false);

    set(baseUrlKey, "https://proxy.example/v1");
    expect(needsBaseUrlStep("openai-compatible")).toBe(false);
    expect(isBaseUrlConfigured("openai-compatible")).toBe(true);
  });

  test("gemini-enterprise needs the gcp-project step until a project is set", () => {
    const projectKey = getProviderProjectEnvKey("gemini-enterprise");
    if (!projectKey) throw new Error("gemini-enterprise must define a project");

    expect(needsGcpProjectStep("gemini-enterprise")).toBe(true);
    set(projectKey, "my-project");
    expect(needsGcpProjectStep("gemini-enterprise")).toBe(false);
  });

  test("no selectable provider currently requires the secret-key step", () => {
    // bedrock is the only provider with a secret-key env var and it is aws-sdk,
    // which the requires-secret-key guard excludes, so the step never appears.
    expect(needsSecretKeyStep("bedrock")).toBe(false);
    expect(needsSecretKeyStep("openai")).toBe(false);

    const secretKey = getProviderSecretKeyEnvKey("bedrock");
    if (!secretKey) throw new Error("bedrock must define a secret key env var");
    expect(isSecretKeyConfigured("bedrock")).toBe(false);
    set(secretKey, "aws-secret");
    expect(isSecretKeyConfigured("bedrock")).toBe(true);
  });

  test("bedrock credential repair triggers only on a partial legacy key pair", () => {
    const accessKey = getProviderApiKeyEnvKey("bedrock");
    if (!accessKey) throw new Error("bedrock must define a legacy access key");

    // A fully absent legacy pair is acceptable (the SDK chain resolves it).
    expect(needsAwsCredentialRepair("bedrock")).toBe(false);
    // Non-aws providers never need aws repair.
    expect(needsAwsCredentialRepair("openai")).toBe(false);

    // Half a legacy pair is a misconfiguration the wizard must surface.
    set(accessKey, "AKIAEXAMPLE");
    expect(needsAwsCredentialRepair("bedrock")).toBe(true);
  });

  test("api-key credential state tracks the pasted key", () => {
    const apiKey = getProviderApiKeyEnvKey("openai");
    if (!apiKey) throw new Error("openai must define an api key env var");

    expect(isCredentialConfigured("openai")).toBe(false);
    expect(needsCredentialStep("openai")).toBe(true);

    set(apiKey, "sk-test");
    expect(isCredentialConfigured("openai")).toBe(true);
    expect(needsCredentialStep("openai")).toBe(false);
  });

  test("oauth and aws providers report the right credential-step need", () => {
    // oauth with no stored token still needs its login step.
    expect(needsCredentialStep("openai-chatgpt")).toBe(true);
    expect(isCredentialConfigured("openai-chatgpt")).toBe(false);
    // aws-sdk has no discrete credential step (credentialStep is null).
    expect(needsCredentialStep("bedrock")).toBe(false);
  });

  test("needsCredentialSetup is true when no provider is configured", () => {
    expect(needsCredentialSetup(null)).toBe(true);

    set("OPENWIKI_PROVIDER", "openai");
    // Provider set but its api key is missing, so setup is still required.
    expect(needsCredentialSetup(null)).toBe(true);
  });
});
