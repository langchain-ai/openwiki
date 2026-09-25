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
import {
  createEmptyOnboardingConfig,
  isOpenWikiOnboardingCompleteSync,
  isRepositoryCodeOnboardingCompleteSync,
} from "../../../src/setup/onboarding.ts";
import type { OpenWikiOnboardingConfig } from "../../../src/setup/onboarding.ts";
import {
  credentialStep,
  ensureRunModeConfig,
  findNearestGitRepoRoot,
  getConfigModeId,
  getConfigModeName,
  getDefaultCodeRepoRootPath,
  getInitialStep,
  getLangsmithRegionLabel,
  getLangsmithRegionSelectionIndex,
  getNextStepAfterApiKey,
  getNextStepAfterBaseUrl,
  getNextStepAfterGcpLocation,
  getNextStepAfterProvider,
  getNextStepAfterRegion,
  getNextStepAfterSecretKey,
  getRunModeName,
  getRunModeSelectionIndex,
  getReasoningEffortSelectionIndex,
  getReasoningEffortSelectionOptions,
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
//
// The two *Sync completeness probes read the real ~/.openwiki directory, so they
// are also stubbed here as vi.fn() (defaulting to "not complete", the value for a
// machine with no onboarding file) and driven per test via vi.mocked below. Only
// needsCredentialSetup consults them; every other function under test uses the
// in-memory isOnboardingComplete instead.
vi.mock("../../../src/setup/onboarding.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/setup/onboarding.ts")>();
  return {
    ...actual,
    readRepositoryWikiInstructions: () => Promise.resolve("hydrated repo goal"),
    isOpenWikiOnboardingCompleteSync: vi.fn(() => false),
    isRepositoryCodeOnboardingCompleteSync: vi.fn(() => false),
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
  "OPENWIKI_REASONING_EFFORT",
  "LANGSMITH_API_KEY",
  "LANGCHAIN_TRACING_V2",
  "OPENAI_CHATGPT_ACCESS_TOKEN",
  "OPENAI_CHATGPT_REFRESH_TOKEN",
  "OPENAI_CHATGPT_ACCOUNT_ID",
  "OPENAI_CHATGPT_EXPIRES_AT",
  getProviderApiKeyEnvKey("openai"),
  getProviderApiKeyEnvKey("openai-compatible"),
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

describe("reasoning effort selection", () => {
  test("offers provider default plus the selected model's supported values", () => {
    expect(
      getReasoningEffortSelectionOptions("openai", "gpt-5.6-luna"),
    ).toEqual([
      { label: "Provider default", value: "" },
      { label: "none", value: "none" },
      { label: "low", value: "low" },
      { label: "medium", value: "medium" },
      { label: "high", value: "high" },
      { label: "xhigh", value: "xhigh" },
      { label: "max", value: "max" },
    ]);
  });

  test("returns no options for unsupported models and falls back to default", () => {
    expect(getReasoningEffortSelectionOptions("openai", "gpt-5.5")).toEqual([]);
    expect(
      getReasoningEffortSelectionIndex(
        "nvidia",
        "nvidia/nemotron-3-super-120b-a12b",
        "max",
      ),
    ).toBe(0);
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

  test("applies the personal template without touching the wiki goal", () => {
    // Switching code -> personal changes the mode but omits the code-only
    // wikiGoal reset, so a pre-existing goal is preserved.
    const code = config({ modeId: "code", wikiGoal: "keep me" });
    const result = ensureRunModeConfig(code, "personal");

    expect(result.modeId).toBe("personal");
    expect(result.templateId).toBe("personal");
    expect(result.wikiGoal).toBe("keep me");
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

  test("needsGcpProjectStep is false for a provider without a project key", () => {
    // openai has no project env key, so its ternary takes the falsey branch.
    expect(needsGcpProjectStep("openai")).toBe(false);
  });

  test("needsBaseUrlStep is false for a provider that does not require one", () => {
    // openai does not require a base url, so the guard returns early.
    expect(needsBaseUrlStep("openai")).toBe(false);
  });

  test("isBaseUrlConfigured is false when the provider has no base-url key", () => {
    // gemini exposes no base-url env key, so the ternary returns its fallback.
    expect(isBaseUrlConfigured("gemini")).toBe(false);
  });

  test("needsRegionStep is false for a provider that does not require one", () => {
    // openai does not require a region, so the guard returns early.
    expect(needsRegionStep("openai")).toBe(false);
  });

  test("isSecretKeyConfigured is false when the provider has no secret key", () => {
    // openai exposes no secret-key env key, so the ternary returns its fallback.
    expect(isSecretKeyConfigured("openai")).toBe(false);
  });
});

/** A minimal, valid ingestion schedule fixture for onboarding gates. */
const SCHEDULE = {
  description: "daily",
  expression: "0 9 * * *",
  updatedAt: "2026-01-01T00:00:00Z",
};

/** Env for a fully satisfied openai run: provider, key, model, and tracing. */
function configureCompleteOpenai(): void {
  const apiKey = getProviderApiKeyEnvKey("openai");
  if (!apiKey) throw new Error("openai must define an api key env var");
  set("OPENWIKI_PROVIDER", "openai");
  set(apiKey, "sk-test");
  set("OPENWIKI_MODEL_ID", "gpt-test");
  set("LANGSMITH_API_KEY", "lsv2_key");
}

describe("needsCredentialSetup waterfall", () => {
  test("surfaces aws credential repair for a partial bedrock legacy pair", () => {
    const accessKey = getProviderApiKeyEnvKey("bedrock");
    if (!accessKey) throw new Error("bedrock must define a legacy access key");
    set("OPENWIKI_PROVIDER", "bedrock");
    set(accessKey, "AKIAEXAMPLE");

    expect(needsCredentialSetup(null)).toBe(true);
  });

  test("requires setup when only the model choice is missing", () => {
    configureCompleteOpenai();
    set("OPENWIKI_MODEL_ID", undefined);

    // modelIdOverride null + no env model id keeps setup required.
    expect(needsCredentialSetup(null)).toBe(true);
    // An explicit per-run model override satisfies the model gate, so with the
    // sync onboarding probe reporting complete, no setup is needed.
    vi.mocked(isOpenWikiOnboardingCompleteSync).mockReturnValue(true);
    expect(needsCredentialSetup("gpt-run", "personal")).toBe(false);
    vi.mocked(isOpenWikiOnboardingCompleteSync).mockReturnValue(false);
  });

  test("requires setup when only the langsmith decision is missing", () => {
    configureCompleteOpenai();
    set("LANGSMITH_API_KEY", undefined);

    expect(needsCredentialSetup(null)).toBe(true);
  });

  test("requires setup when only a base url is missing", () => {
    const apiKey = getProviderApiKeyEnvKey("openai-compatible");
    if (!apiKey) throw new Error("openai-compatible must define an api key");
    set("OPENWIKI_PROVIDER", "openai-compatible");
    set(apiKey, "sk-test");
    set("OPENWIKI_MODEL_ID", "gpt-test");
    set("LANGSMITH_API_KEY", "lsv2_key");

    // Credential and model gates pass but the base-url gate keeps setup on.
    expect(needsCredentialSetup(null)).toBe(true);
  });

  test("falls through to the onboarding probe once credentials are complete", () => {
    configureCompleteOpenai();

    // personal mode consults the OpenWiki onboarding probe.
    vi.mocked(isOpenWikiOnboardingCompleteSync).mockReturnValue(false);
    expect(needsCredentialSetup(null, "personal")).toBe(true);
    vi.mocked(isOpenWikiOnboardingCompleteSync).mockReturnValue(true);
    expect(needsCredentialSetup(null, "personal")).toBe(false);

    // code mode consults the repository code onboarding probe instead.
    vi.mocked(isRepositoryCodeOnboardingCompleteSync).mockReturnValue(false);
    expect(needsCredentialSetup(null, "code")).toBe(true);
    vi.mocked(isRepositoryCodeOnboardingCompleteSync).mockReturnValue(true);
    expect(needsCredentialSetup(null, "code")).toBe(false);

    vi.mocked(isOpenWikiOnboardingCompleteSync).mockReturnValue(false);
    vi.mocked(isRepositoryCodeOnboardingCompleteSync).mockReturnValue(false);
  });
});

describe("getInitialStep waterfall", () => {
  test("routes to provider selection when none is configured", () => {
    // OPENWIKI_PROVIDER is cleared by beforeEach, so no provider is valid.
    expect(getInitialStep(null, "openai")).toBe("provider");
  });

  test("routes to region for a bedrock partial legacy pair (aws repair)", () => {
    const accessKey = getProviderApiKeyEnvKey("bedrock");
    if (!accessKey) throw new Error("bedrock must define a legacy access key");
    set("OPENWIKI_PROVIDER", "bedrock");
    set(accessKey, "AKIAEXAMPLE");

    expect(getInitialStep(null, "bedrock")).toBe("region");
  });

  test("routes to the provider's credential step when it is unmet", () => {
    set("OPENWIKI_PROVIDER", "openai");
    // No api key set, so openai still needs its api-key step.
    expect(getInitialStep(null, "openai")).toBe("api-key");

    // gemini-enterprise's primary credential is its gcp project.
    set("OPENWIKI_PROVIDER", "gemini-enterprise");
    expect(getInitialStep(null, "gemini-enterprise")).toBe("gcp-project");
  });

  test("routes to base-url once credentials are met but a base url is missing", () => {
    const apiKey = getProviderApiKeyEnvKey("openai-compatible");
    if (!apiKey) throw new Error("openai-compatible must define an api key");
    set("OPENWIKI_PROVIDER", "openai-compatible");
    set(apiKey, "sk-test");

    expect(getInitialStep(null, "openai-compatible")).toBe("base-url");
  });

  test("routes to region once credentials are met but a region is missing", () => {
    set("OPENWIKI_PROVIDER", "bedrock");
    // A bearer token satisfies the aws credential chain, leaving only region.
    set(AWS_BEARER_TOKEN_BEDROCK_ENV_KEY, "bedrock-token");

    expect(getInitialStep(null, "bedrock")).toBe("region");
  });

  test("routes to model, then langsmith, once credentials are met", () => {
    const apiKey = getProviderApiKeyEnvKey("openai");
    if (!apiKey) throw new Error("openai must define an api key env var");
    set("OPENWIKI_PROVIDER", "openai");
    set(apiKey, "sk-test");

    // No model id anywhere yet, so the model step comes next.
    expect(getInitialStep(null, "openai")).toBe("model");

    // A per-run override satisfies the model gate; langsmith is next.
    expect(getInitialStep("gpt-run", "openai")).toBe("langsmith");
  });

  test("walks the onboarding tail in personal mode", () => {
    configureCompleteOpenai();

    // Empty config: no mode chosen yet, so the template step comes first.
    expect(getInitialStep(null, "openai", config(), "personal")).toBe(
      "template",
    );

    // Mode chosen but no wiki goal.
    expect(
      getInitialStep(
        null,
        "openai",
        config({ modeId: "personal" }),
        "personal",
      ),
    ).toBe("wiki-goal");

    // Goal set but no schedule (personal mode requires one).
    expect(
      getInitialStep(
        null,
        "openai",
        config({ modeId: "personal", wikiGoal: "g" }),
        "personal",
      ),
    ).toBe("global-cron-mode");

    // Schedule set but onboarding not yet completed.
    expect(
      getInitialStep(
        null,
        "openai",
        config({
          modeId: "personal",
          wikiGoal: "g",
          ingestionSchedule: SCHEDULE,
        }),
        "personal",
      ),
    ).toBe("source-menu");

    // Fully complete onboarding resolves to no further step.
    expect(
      getInitialStep(
        null,
        "openai",
        config({
          modeId: "personal",
          wikiGoal: "g",
          ingestionSchedule: SCHEDULE,
          completedAt: "2026-01-01T00:00:00Z",
        }),
        "personal",
      ),
    ).toBeNull();
  });

  test("routes to repo confirmation in incomplete code mode", () => {
    configureCompleteOpenai();

    expect(getInitialStep(null, "openai", config(), "code")).toBe(
      "code-repo-confirm",
    );

    // A complete code config skips the repo step and resolves to null.
    expect(
      getInitialStep(
        null,
        "openai",
        config({
          modeId: "code",
          wikiGoal: "g",
          completedAt: "2026-01-01T00:00:00Z",
        }),
        "code",
      ),
    ).toBeNull();
  });
});

/**
 * The LangSmith step is optional, and both entry-point routers (getInitialStep
 * and getNextStepAfterRegion) must gate it on the same two-signal check as
 * needsLangSmithStep: a recorded tracing decision (LANGCHAIN_TRACING_V2) counts
 * as answered even when no key is stored. The row that regressed before this was
 * unified is "declined" (LANGCHAIN_TRACING_V2="false", no key): the naive
 * `!LANGSMITH_API_KEY` check re-prompted it on every re-run.
 */
describe("LangSmith skip-router gating", () => {
  const empty = createEmptyOnboardingConfig();

  /** Configures a valid openai provider so routing reaches the LangSmith gate. */
  function reachLangSmithGate(): void {
    const apiKey = getProviderApiKeyEnvKey("openai");
    if (!apiKey) throw new Error("openai must define an api key env var");
    set("OPENWIKI_PROVIDER", "openai");
    set(apiKey, "sk-test");
    set("OPENWIKI_MODEL_ID", "gpt-test");
  }

  // Each row is [label, LANGSMITH_API_KEY, LANGCHAIN_TRACING_V2, showsLangSmith].
  const cases: Array<
    [string, string | undefined, string | undefined, boolean]
  > = [
    ["neither key nor decision recorded", undefined, undefined, true],
    ["a stored api key", "lsv2_key", undefined, false],
    ["a declined tracing decision", undefined, "false", false],
    ["an enabled tracing decision", undefined, "true", false],
  ];

  for (const [label, key, tracing, showsLangSmith] of cases) {
    test(`getInitialStep ${
      showsLangSmith ? "shows" : "skips"
    } LangSmith with ${label}`, () => {
      reachLangSmithGate();
      set("LANGSMITH_API_KEY", key);
      set("LANGCHAIN_TRACING_V2", tracing);

      // Model id present via env, empty code config: the only fork left is the
      // LangSmith gate, then code-repo-confirm once it is satisfied.
      expect(getInitialStep(null, "openai", empty, "code")).toBe(
        showsLangSmith ? "langsmith" : "code-repo-confirm",
      );
    });

    test(`getNextStepAfterRegion ${
      showsLangSmith ? "shows" : "skips"
    } LangSmith with ${label}`, () => {
      set("LANGSMITH_API_KEY", key);
      set("LANGCHAIN_TRACING_V2", tracing);

      // modelIdOverride satisfies the model gate, so the LangSmith gate is the
      // next fork; code mode with an empty config lands on code-repo-confirm.
      expect(getNextStepAfterRegion("openai", "gpt-run", empty, "code")).toBe(
        showsLangSmith ? "langsmith" : "code-repo-confirm",
      );
    });
  }
});

describe("getNextStepAfter* chain", () => {
  const empty = createEmptyOnboardingConfig();

  test("getNextStepAfterProvider surfaces aws repair then the credential step", () => {
    const accessKey = getProviderApiKeyEnvKey("bedrock");
    if (!accessKey) throw new Error("bedrock must define a legacy access key");
    set(accessKey, "AKIAEXAMPLE");
    expect(getNextStepAfterProvider("bedrock", null, empty)).toBe("region");
    set(accessKey, undefined);

    // openai with no key advances to its api-key step.
    expect(getNextStepAfterProvider("openai", null, empty)).toBe("api-key");
  });

  test("getNextStepAfterProvider cascades through every satisfied gate", () => {
    const apiKey = getProviderApiKeyEnvKey("openai");
    if (!apiKey) throw new Error("openai must define an api key env var");
    set(apiKey, "sk-test");

    // With the credential satisfied and nothing else configured, the whole
    // Provider -> ApiKey -> SecretKey -> GcpLocation -> BaseUrl -> Region chain
    // falls through to the model step.
    expect(getNextStepAfterProvider("openai", null, empty, "personal")).toBe(
      "model",
    );
  });

  test("getNextStepAfterSecretKey routes a keyless provider to its gcp project", () => {
    // gemini-enterprise needs a gcp project when none is configured.
    expect(
      getNextStepAfterSecretKey("gemini-enterprise", null, empty, "code"),
    ).toBe("gcp-project");
  });

  test("getNextStepAfterGcpLocation routes to base-url when one is missing", () => {
    expect(getNextStepAfterGcpLocation("openai-compatible", null, empty)).toBe(
      "base-url",
    );
  });

  test("getNextStepAfterBaseUrl routes to region when one is missing", () => {
    expect(getNextStepAfterBaseUrl("bedrock", null, empty, "code")).toBe(
      "region",
    );
  });

  test("getNextStepAfterApiKey delegates past the (unreachable) secret-key step", () => {
    // No selectable provider requires a secret key, so this delegates straight
    // through to the gcp-project probe for a keyless provider.
    expect(
      getNextStepAfterApiKey("gemini-enterprise", null, empty, "code"),
    ).toBe("gcp-project");
  });

  test("getNextStepAfterRegion forces the model step when asked", () => {
    set("OPENWIKI_MODEL_ID", "gpt-test");
    set("LANGSMITH_API_KEY", "lsv2_key");
    // Even with a model id present, forceModelStep re-shows the model step.
    expect(getNextStepAfterRegion("openai", null, empty, "code", true)).toBe(
      "model",
    );
    // Without the force flag, the present model id lets the step be skipped.
    expect(getNextStepAfterRegion("openai", null, empty, "code", false)).toBe(
      "code-repo-confirm",
    );
  });

  test("getNextStepAfterRegion walks model, langsmith, and the onboarding tail", () => {
    // No model id and no override -> model step.
    expect(getNextStepAfterRegion("openai", null, empty, "personal")).toBe(
      "model",
    );

    // Model satisfied via override, no langsmith key -> langsmith step.
    expect(getNextStepAfterRegion("openai", "gpt-run", empty, "personal")).toBe(
      "langsmith",
    );

    // Model + langsmith satisfied -> onboarding tail (personal).
    set("LANGSMITH_API_KEY", "lsv2_key");
    expect(getNextStepAfterRegion("openai", "gpt-run", empty, "personal")).toBe(
      "template",
    );
    expect(
      getNextStepAfterRegion(
        "openai",
        "gpt-run",
        config({ modeId: "personal" }),
        "personal",
      ),
    ).toBe("wiki-goal");
    expect(
      getNextStepAfterRegion(
        "openai",
        "gpt-run",
        config({ modeId: "personal", wikiGoal: "g" }),
        "personal",
      ),
    ).toBe("global-cron-mode");
    expect(
      getNextStepAfterRegion(
        "openai",
        "gpt-run",
        config({
          modeId: "personal",
          wikiGoal: "g",
          ingestionSchedule: SCHEDULE,
        }),
        "personal",
      ),
    ).toBe("source-menu");
    expect(
      getNextStepAfterRegion(
        "openai",
        "gpt-run",
        config({
          modeId: "personal",
          wikiGoal: "g",
          ingestionSchedule: SCHEDULE,
          completedAt: "2026-01-01T00:00:00Z",
        }),
        "personal",
      ),
    ).toBeNull();
  });

  test("getNextStepAfterRegion routes code mode to repo confirmation", () => {
    set("LANGSMITH_API_KEY", "lsv2_key");
    expect(getNextStepAfterRegion("openai", "gpt-run", empty, "code")).toBe(
      "code-repo-confirm",
    );
  });
});

describe("git repo root discovery", () => {
  test("findNearestGitRepoRoot finds the repo containing this test run", () => {
    // The vitest process runs inside the OpenWiki git repo.
    expect(findNearestGitRepoRoot(process.cwd())).not.toBeNull();
  });

  test("findNearestGitRepoRoot returns null when no .git ancestor exists", () => {
    // The filesystem root has no .git directory above it.
    expect(findNearestGitRepoRoot("/")).toBeNull();
  });

  test("findNearestGitRepoRoot walks up from a nested subdirectory", () => {
    // A directory below the repo root forces at least one parent hop before the
    // .git directory is found.
    const root = findNearestGitRepoRoot(process.cwd());
    expect(findNearestGitRepoRoot(`${process.cwd()}/src/setup`)).toBe(root);
  });

  test("getDefaultCodeRepoRootPath resolves to a real directory string", () => {
    expect(typeof getDefaultCodeRepoRootPath()).toBe("string");
    expect(getDefaultCodeRepoRootPath().length).toBeGreaterThan(0);
  });
});
