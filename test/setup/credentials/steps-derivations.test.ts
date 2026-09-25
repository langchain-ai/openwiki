import { afterEach, describe, expect, test, vi } from "vitest";
import { homedir } from "node:os";
import path from "node:path";

import {
  getDefaultModelId,
  getProviderLabel,
  getProviderModelOptions,
  OPENWIKI_MODEL_ID_ENV_KEY,
  SELECTABLE_OPENWIKI_PROVIDERS,
} from "../../../src/config/constants.ts";
import type { OpenWikiProvider } from "../../../src/config/constants.ts";
import {
  createEmptyOnboardingConfig,
  type OnboardingSourceInstanceConfig,
  type OpenWikiOnboardingConfig,
} from "../../../src/setup/onboarding.ts";
import {
  ONBOARDING_TEMPLATES,
  SOURCE_OPTIONS,
} from "../../../src/setup/credentials/constants.ts";
import type { SourceSetupOption } from "../../../src/setup/credentials/types.ts";
import {
  addSourceInstanceConfig,
  createSourceInstanceId,
  createSourceInstanceName,
  deriveLegacySources,
  getApiKeyFieldLabel,
  getConnectedSourceCount,
  getCronFields,
  getDefaultLocalGitRepoPath,
  getErrorMessage,
  getFinalOptionLabel,
  getInputDisplayWidth,
  getModelSelectionIndex,
  getModelSelectionOptions,
  getModelSetupDetail,
  getProviderArticle,
  getProviderSelectionIndex,
  getSelectedModelId,
  getSourceDescriptionOptionCount,
  getSourceDescriptionPrompt,
  getSourceInstanceCount,
  getSourceInstances,
  getSourceMenuLabel,
  getStaticSourceConfig,
  getTemplateGoal,
  getTemplateSourceOptions,
  handleCronEditorInput,
  isScheduleStep,
  isSourceStep,
  moveSelectionIndex,
  needsEnvValue,
  normalizeLocalPath,
  parseCronFieldPaste,
  sanitizeCronInputChunk,
  sanitizeInputChunk,
  sanitizeRepoId,
  shouldStartWithCustomModelInput,
  validateLocalDirectoryPath,
} from "../../../src/setup/credentials/steps.ts";

/** Provider that ships preset model options (used for model-selection tests). */
const PROVIDER_WITH_PRESETS: OpenWikiProvider =
  SELECTABLE_OPENWIKI_PROVIDERS.find(
    (provider) => getProviderModelOptions(provider).length > 0,
  ) ?? "anthropic";

/** A real source option so fixtures match the production shape exactly. */
function sourceOption(id: string): SourceSetupOption {
  const option = SOURCE_OPTIONS.find((source) => source.id === id);
  if (!option) throw new Error(`no source option for ${id}`);
  return option;
}

/** An onboarding config carrying the given source instances. */
function configWith(
  ...instances: OnboardingSourceInstanceConfig[]
): OpenWikiOnboardingConfig {
  return { ...createEmptyOnboardingConfig(), sourceInstances: instances };
}

/** A source instance fixture with only the fields the helpers read. */
function instance(
  connectorId: OnboardingSourceInstanceConfig["connectorId"],
  overrides: Partial<OnboardingSourceInstanceConfig> = {},
): OnboardingSourceInstanceConfig {
  return {
    connectorId,
    id: `${connectorId}-fixture`,
    ingestionGoal: "goal",
    ...overrides,
  };
}

describe("string + error helpers", () => {
  test("sanitizeInputChunk drops carriage returns and newlines only", () => {
    expect(sanitizeInputChunk("a\r\nb\nc")).toBe("abc");
    expect(sanitizeInputChunk("plain text 1!")).toBe("plain text 1!");
  });

  test("sanitizeCronInputChunk keeps only cron-legal characters", () => {
    expect(sanitizeCronInputChunk("*/5")).toBe("*/5");
    // Spaces and punctuation outside the allowlist are stripped.
    expect(sanitizeCronInputChunk("1 2!")).toBe("12");
    expect(sanitizeCronInputChunk("Mon#3,L-W")).toBe("Mon#3,L-W");
  });

  test("sanitizeRepoId allowlists, truncates to 80 chars, and never empties", () => {
    expect(sanitizeRepoId("my repo/name")).toBe("my-repo-name");
    expect(sanitizeRepoId("")).toBe("repo");
    expect(sanitizeRepoId("!!!")).toBe("---");
    expect(sanitizeRepoId("a".repeat(200))).toHaveLength(80);
  });

  test("getErrorMessage unwraps Error and stringifies everything else", () => {
    expect(getErrorMessage(new Error("boom"))).toBe("boom");
    expect(getErrorMessage("raw")).toBe("raw");
    expect(getErrorMessage(42)).toBe("42");
  });
});

describe("path helpers", () => {
  test("getDefaultLocalGitRepoPath is the process working directory", () => {
    expect(getDefaultLocalGitRepoPath()).toBe(process.cwd());
  });

  test("normalizeLocalPath expands ~ and resolves relative paths", () => {
    expect(normalizeLocalPath("")).toBe("");
    expect(normalizeLocalPath("  ")).toBe("");
    expect(normalizeLocalPath("~")).toBe(homedir());
    expect(normalizeLocalPath("~/sub")).toBe(path.resolve(homedir(), "sub"));
    // A Windows-style tilde prefix is expanded the same way.
    expect(normalizeLocalPath("~\\sub")).toBe(path.resolve(homedir(), "sub"));
    expect(normalizeLocalPath("./rel")).toBe(path.resolve("./rel"));
  });

  test("validateLocalDirectoryPath resolves a real directory and rejects empties", async () => {
    await expect(validateLocalDirectoryPath(process.cwd())).resolves.toBe(
      process.cwd(),
    );
    await expect(validateLocalDirectoryPath("   ")).rejects.toThrow(
      "Enter a local directory.",
    );
    // A path that exists but is a file, not a directory, is rejected.
    await expect(
      validateLocalDirectoryPath(`${process.cwd()}/package.json`),
    ).rejects.toThrow("is not a directory.");
  });
});

describe("step-kind predicates", () => {
  test("isSourceStep matches the source- prefix", () => {
    expect(isSourceStep("source-auth")).toBe(true);
    expect(isSourceStep("api-key")).toBe(false);
    expect(isSourceStep(null)).toBe(false);
  });

  test("isScheduleStep matches the global- prefix", () => {
    expect(isScheduleStep("global-cron-mode")).toBe(true);
    expect(isScheduleStep("api-key")).toBe(false);
    expect(isScheduleStep(null)).toBe(false);
  });
});

describe("model selection", () => {
  test("getApiKeyFieldLabel names an access key id only for bedrock", () => {
    expect(getApiKeyFieldLabel("bedrock")).toContain("access key ID");
    expect(getApiKeyFieldLabel("openai")).toBe(
      `${getProviderLabel("openai")} API key`,
    );
  });

  test("getProviderArticle picks the grammatically correct article", () => {
    expect(getProviderArticle("gemini")).toBe("a");
    expect(getProviderArticle("anthropic")).toBe("an");
    expect(getProviderArticle("openai")).toBe("an");
  });

  test("getModelSelectionOptions lists every preset then a custom trailer", () => {
    const options = getModelSelectionOptions(PROVIDER_WITH_PRESETS);
    const presetIds = getProviderModelOptions(PROVIDER_WITH_PRESETS).map(
      (model) => model.id,
    );

    expect(options.at(-1)).toEqual({ kind: "custom" });
    expect(
      options
        .filter((option) => option.kind === "preset")
        .map((option) => (option.kind === "preset" ? option.id : "")),
    ).toEqual(presetIds);
  });

  test("shouldStartWithCustomModelInput iff the provider has no presets", () => {
    for (const provider of SELECTABLE_OPENWIKI_PROVIDERS) {
      expect(shouldStartWithCustomModelInput(provider)).toBe(
        getProviderModelOptions(provider).length === 0,
      );
    }
  });

  test("getSelectedModelId resolves preset index, custom trailer, and misses", () => {
    const options = getModelSelectionOptions(PROVIDER_WITH_PRESETS);
    const firstPreset = options[0];
    if (firstPreset?.kind !== "preset") {
      throw new Error("expected a preset at index 0");
    }

    expect(getSelectedModelId(PROVIDER_WITH_PRESETS, 0, "", false)).toBe(
      firstPreset.id,
    );
    expect(
      getSelectedModelId(PROVIDER_WITH_PRESETS, options.length - 1, "", false),
    ).toBe("custom");
    // Out of range and blank custom input both resolve to no selection.
    expect(
      getSelectedModelId(PROVIDER_WITH_PRESETS, 999, "", false),
    ).toBeNull();
    expect(
      getSelectedModelId(PROVIDER_WITH_PRESETS, 0, "   ", true),
    ).toBeNull();
    // A valid custom id is normalized (trimmed) and returned verbatim.
    expect(
      getSelectedModelId(PROVIDER_WITH_PRESETS, 0, "  my-custom-model  ", true),
    ).toBe("my-custom-model");
  });

  test("getModelSelectionIndex finds a preset and defaults unknown ids to 0", () => {
    const presetId = getProviderModelOptions(PROVIDER_WITH_PRESETS)[0]?.id;
    if (!presetId) throw new Error("expected at least one preset model");

    expect(
      getModelSelectionIndex(PROVIDER_WITH_PRESETS, presetId),
    ).toBeGreaterThanOrEqual(0);
    expect(getModelSelectionIndex(PROVIDER_WITH_PRESETS, "no-such-model")).toBe(
      0,
    );
  });

  test("getProviderSelectionIndex mirrors the selectable provider order", () => {
    for (const provider of SELECTABLE_OPENWIKI_PROVIDERS) {
      expect(getProviderSelectionIndex(provider)).toBe(
        SELECTABLE_OPENWIKI_PROVIDERS.indexOf(provider),
      );
    }
    // An unknown provider falls back to the first selectable index.
    expect(getProviderSelectionIndex("bogus" as never)).toBe(0);
  });
});

describe("getModelSetupDetail", () => {
  const priorModelId = process.env[OPENWIKI_MODEL_ID_ENV_KEY];

  afterEach(() => {
    if (priorModelId === undefined) {
      delete process.env[OPENWIKI_MODEL_ID_ENV_KEY];
    } else {
      process.env[OPENWIKI_MODEL_ID_ENV_KEY] = priorModelId;
    }
  });

  test("prefers an explicit per-run override", () => {
    delete process.env[OPENWIKI_MODEL_ID_ENV_KEY];
    expect(getModelSetupDetail("custom-model", "anthropic")).toBe(
      "using custom-model for this run",
    );
  });

  test("falls back to the configured env model, then the provider default", () => {
    process.env[OPENWIKI_MODEL_ID_ENV_KEY] = "env-model";
    expect(getModelSetupDetail(null, "anthropic")).toBe("env-model");

    delete process.env[OPENWIKI_MODEL_ID_ENV_KEY];
    expect(getModelSetupDetail(null, "anthropic")).toBe(
      `default ${getDefaultModelId("anthropic")}`,
    );
  });
});

describe("index + width math", () => {
  test("moveSelectionIndex wraps around and guards an empty list", () => {
    expect(moveSelectionIndex(0, -1, 3)).toBe(2);
    expect(moveSelectionIndex(2, 1, 3)).toBe(0);
    expect(moveSelectionIndex(1, 1, 3)).toBe(2);
    expect(moveSelectionIndex(0, 1, 0)).toBe(0);
  });

  test("getInputDisplayWidth defaults and clamps to the 24..96 band", () => {
    expect(getInputDisplayWidth(undefined)).toBe(64);
    expect(getInputDisplayWidth(0)).toBe(64);
    expect(getInputDisplayWidth(40)).toBe(24);
    expect(getInputDisplayWidth(100)).toBe(84);
    expect(getInputDisplayWidth(1000)).toBe(96);
  });
});

describe("template + source labelling", () => {
  test("getTemplateGoal returns a known template goal, empty for unknown", () => {
    const template = ONBOARDING_TEMPLATES[0];
    expect(getTemplateGoal(template.id)).toBe(template.suggestedGoal ?? "");
    expect(getTemplateGoal("no-such-template")).toBe("");
  });

  test("getTemplateSourceOptions falls back to all sources for unknown ids", () => {
    const options = getTemplateSourceOptions("no-such-template");
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(SOURCE_OPTIONS).toContain(option);
    }
  });

  test("getSourceMenuLabel switches to 'another' once one is connected", () => {
    const option = sourceOption("git-repo");
    expect(getSourceMenuLabel(option, 0)).toBe(`Add ${option.displayName}`);
    expect(getSourceMenuLabel(option, 2)).toBe(
      `Add another ${option.displayName}`,
    );
  });

  test("getSourceDescriptionPrompt is source-specific with a generic fallback", () => {
    expect(getSourceDescriptionPrompt(sourceOption("web-search"))).toContain(
      "search for",
    );
    expect(getSourceDescriptionPrompt(sourceOption("hackernews"))).toContain(
      "Hacker News",
    );
    expect(getSourceDescriptionPrompt(sourceOption("git-repo"))).toContain(
      "repository",
    );
    // Any other source falls back to the generic, name-interpolated prompt.
    const generic = sourceOption("langsmith");
    expect(getSourceDescriptionPrompt(generic)).toBe(
      `Describe what OpenWiki should look for in ${generic.displayName}.`,
    );
  });

  test("getSourceDescriptionOptionCount is the examples plus the free-form entry", () => {
    const option = sourceOption("git-repo");
    expect(getSourceDescriptionOptionCount(option)).toBe(
      option.examples.length + 1,
    );
  });

  test("getFinalOptionLabel rewrites the labels only in code mode", () => {
    expect(getFinalOptionLabel("Run ingestion now", "personal")).toBe(
      "Run ingestion now",
    );
    expect(getFinalOptionLabel("Run ingestion now", "code")).toBe(
      "Run OpenWiki now",
    );
    expect(getFinalOptionLabel("Run later", "code")).toBe("Open chat");
  });
});

describe("getStaticSourceConfig", () => {
  test("builds a web-search config carrying the trimmed query", () => {
    expect(getStaticSourceConfig("web-search", "  langchain  ")).toMatchObject({
      enabled: true,
      queries: ["langchain"],
      topic: "general",
      searchDepth: "basic",
    });
    expect(getStaticSourceConfig("web-search", "   ").queries).toEqual([]);
  });

  test("builds a hackernews config with feeds and query tags", () => {
    expect(getStaticSourceConfig("hackernews", "ai")).toMatchObject({
      enabled: true,
      feeds: ["top", "new"],
      queries: ["ai"],
      queryTags: ["story"],
    });
  });

  test("defaults every other source to just enabled", () => {
    expect(getStaticSourceConfig("git-repo", "ignored")).toEqual({
      enabled: true,
    });
  });
});

describe("source instance derivation", () => {
  test("deriveLegacySources keeps the first instance per connector", () => {
    const sources = deriveLegacySources([
      instance("git-repo", { ingestionGoal: "first" }),
      instance("git-repo", { ingestionGoal: "second" }),
      instance("web-search", { ingestionGoal: "web" }),
    ]);

    expect(Object.keys(sources).sort()).toEqual(["git-repo", "web-search"]);
    expect(sources["git-repo"]?.ingestionGoal).toBe("first");
  });

  test("addSourceInstanceConfig appends and re-derives legacy sources", () => {
    const base = configWith(instance("git-repo"));
    const next = addSourceInstanceConfig(base, instance("web-search"));

    expect(next.sourceInstances).toHaveLength(2);
    expect(Object.keys(next.sources).sort()).toEqual([
      "git-repo",
      "web-search",
    ]);
    // The input config is not mutated.
    expect(base.sourceInstances).toHaveLength(1);
  });

  test("getSourceInstances / getSourceInstanceCount filter by connector", () => {
    const config = configWith(
      instance("git-repo"),
      instance("git-repo"),
      instance("web-search"),
    );

    expect(getSourceInstanceCount(config, "git-repo")).toBe(2);
    expect(getSourceInstances(config, "web-search")).toHaveLength(1);
    expect(getSourceInstanceCount(config, "hackernews")).toBe(0);
  });

  test("getConnectedSourceCount counts instances within the option set", () => {
    const config = configWith(
      instance("git-repo"),
      instance("web-search"),
      instance("hackernews"),
    );

    expect(getConnectedSourceCount(config, [sourceOption("git-repo")])).toBe(1);
    expect(
      getConnectedSourceCount(config, [
        sourceOption("git-repo"),
        sourceOption("web-search"),
      ]),
    ).toBe(2);
  });

  test("createSourceInstanceId numbers sequentially per connector", () => {
    const empty = createEmptyOnboardingConfig();
    expect(createSourceInstanceId("git-repo", empty)).toBe("git-repo-1");
    expect(
      createSourceInstanceId("git-repo", configWith(instance("git-repo"))),
    ).toBe("git-repo-2");
  });

  test("createSourceInstanceName appends the trimmed description and caps length", () => {
    const option = sourceOption("git-repo");
    const empty = createEmptyOnboardingConfig();

    expect(createSourceInstanceName(option, "  my repo ", empty)).toBe(
      `${option.displayName} 1: my repo`,
    );
    expect(createSourceInstanceName(option, "   ", empty)).toBe(
      `${option.displayName} 1`,
    );
    expect(
      createSourceInstanceName(option, "x".repeat(200), empty).length,
    ).toBeLessThanOrEqual(120);
  });
});

describe("needsEnvValue", () => {
  const envKey = "OPENWIKI_STEPS_TEST_SECRET";

  afterEach(() => {
    delete process.env[envKey];
  });

  test("is true only when the referenced env var is unset or blank", () => {
    delete process.env[envKey];
    expect(needsEnvValue({ envKey, label: "Secret", secret: true })).toBe(true);

    process.env[envKey] = "present";
    expect(needsEnvValue({ envKey, label: "Secret", secret: true })).toBe(
      false,
    );
  });
});

describe("cron field editing", () => {
  test("getCronFields splits an expression, padding missing fields", () => {
    expect(getCronFields("* * * * *", "0 0 * * *")).toEqual([
      "*",
      "*",
      "*",
      "*",
      "*",
    ]);
    // A blank expression falls back to the provided default.
    expect(getCronFields("", "0 9 * * 1")).toEqual(["0", "9", "*", "*", "1"]);
    expect(getCronFields("1 2", "0 0 * * *")).toEqual(["1", "2", "", "", ""]);
  });

  test("parseCronFieldPaste splits whitespace and 5-digit compact forms", () => {
    expect(parseCronFieldPaste("1 2 3 4 5")).toEqual(["1", "2", "3", "4", "5"]);
    expect(parseCronFieldPaste("12345")).toEqual(["1", "2", "3", "4", "5"]);
    expect(parseCronFieldPaste("")).toEqual([]);
    // A non-numeric compact string is not a paste.
    expect(parseCronFieldPaste("abcde")).toEqual([]);
  });

  test("handleCronEditorInput moves fields and edits the value via setters", () => {
    const setValue = vi.fn();
    const setCurrentFieldIndex = vi.fn();
    const setReplaceCurrentField = vi.fn();
    const call = (
      inputValue: string,
      key: Parameters<typeof handleCronEditorInput>[0]["key"],
      currentValue = "* * * * *",
      currentFieldIndex = 0,
      replaceCurrentField = true,
    ): boolean =>
      handleCronEditorInput({
        currentFieldIndex,
        currentValue,
        fallbackExpression: "0 0 * * *",
        inputValue,
        key,
        replaceCurrentField,
        setCurrentFieldIndex,
        setReplaceCurrentField,
        setValue,
      });

    // Right arrow advances the active field.
    expect(call("", { rightArrow: true })).toBe(true);
    const advance = setCurrentFieldIndex.mock.calls[0]?.[0] as (
      index: number,
    ) => number;
    expect(advance(0)).toBe(1);

    // A ctrl chord is not consumed.
    expect(call("c", { ctrl: true })).toBe(false);

    // A legal character writes the joined expression back.
    setValue.mockClear();
    expect(call("5", {}, "* * * * *", 0, true)).toBe(true);
    expect(setValue).toHaveBeenCalledWith("5 * * * *");
  });

  test("handleCronEditorInput handles arrows, backspace, paste, and appends", () => {
    const setValue = vi.fn();
    const setCurrentFieldIndex = vi.fn();
    const setReplaceCurrentField = vi.fn();
    const call = (
      inputValue: string,
      key: Parameters<typeof handleCronEditorInput>[0]["key"],
      currentValue = "* * * * *",
      currentFieldIndex = 0,
      replaceCurrentField = true,
    ): boolean =>
      handleCronEditorInput({
        currentFieldIndex,
        currentValue,
        fallbackExpression: "0 0 * * *",
        inputValue,
        key,
        replaceCurrentField,
        setCurrentFieldIndex,
        setReplaceCurrentField,
        setValue,
      });

    // Left arrow steps the active field back, clamped at zero.
    expect(call("", { leftArrow: true }, "* * * * *", 2)).toBe(true);
    const back = setCurrentFieldIndex.mock.calls[0]?.[0] as (
      index: number,
    ) => number;
    expect(back(2)).toBe(1);
    expect(back(0)).toBe(0);

    // Backspace on a non-empty field trims its last character.
    setValue.mockClear();
    expect(call("", { backspace: true }, "12 * * * *", 0)).toBe(true);
    expect(setValue).toHaveBeenCalledWith("1 * * * *");

    // Backspace on an already-empty field hops to the previous field instead.
    setValue.mockClear();
    setCurrentFieldIndex.mockClear();
    expect(call("", { backspace: true }, "1", 1)).toBe(true);
    expect(setCurrentFieldIndex).toHaveBeenCalledWith(0);
    expect(setValue).not.toHaveBeenCalled();

    // A multi-field paste distributes across the fields from the cursor.
    setValue.mockClear();
    expect(call("1 2 3", {}, "* * * * *", 0)).toBe(true);
    expect(setValue).toHaveBeenCalledWith("1 2 3 * *");

    // A paste that overflows the field list drops the fields past the end.
    setValue.mockClear();
    setCurrentFieldIndex.mockClear();
    expect(call("7 8 9", {}, "* * * * *", 4)).toBe(true);
    expect(setValue).toHaveBeenCalledWith("* * * * 7");
    // The cursor updater clamps to the last field after a long paste.
    const clamp = setCurrentFieldIndex.mock.calls[0]?.[0] as (
      index: number,
    ) => number;
    expect(clamp(4)).toBe(4);

    // Input that sanitizes to nothing is not consumed.
    expect(call("!", {}, "* * * * *", 0)).toBe(false);

    // With replace disabled, a legal character appends to the current field.
    setValue.mockClear();
    expect(call("2", {}, "1 * * * *", 0, false)).toBe(true);
    expect(setValue).toHaveBeenCalledWith("12 * * * *");
  });
});
