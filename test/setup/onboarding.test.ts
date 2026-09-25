import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalHome = process.env.HOME;
const originalConfigDir = process.env.OPENWIKI_CONFIG_DIR;
const tempHomes: string[] = [];

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-onboarding-"));
  tempHomes.push(home);
  return home;
}

async function loadOnboardingModule(home: string) {
  vi.resetModules();
  // `os.homedir()` reads USERPROFILE on Windows and ignores HOME, so setting
  // HOME alone leaves the real ~/.openwiki exposed there. Point the config dir
  // at the temp home explicitly so the isolation holds on every platform.
  process.env.HOME = home;
  process.env.OPENWIKI_CONFIG_DIR = path.join(home, ".openwiki");
  return await import("../../src/setup/onboarding.ts");
}

// Writes a raw (un-normalized) onboarding.json so we can read it back through
// readOpenWikiOnboardingConfig and observe how normalizeOnboardingConfig
// sanitizes it. This is the public seam for the otherwise-private normalizer.
async function seedRawOnboardingJson(
  onboarding: Awaited<ReturnType<typeof loadOnboardingModule>>,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(onboarding.openWikiOnboardingPath), {
    recursive: true,
  });
  await writeFile(
    onboarding.openWikiOnboardingPath,
    `${JSON.stringify(value)}\n`,
    "utf8",
  );
}

// Writes an arbitrary (possibly invalid) string to onboarding.json so we can
// exercise the JSON.parse failure paths that seedRawOnboardingJson cannot.
async function seedRawOnboardingText(
  onboarding: Awaited<ReturnType<typeof loadOnboardingModule>>,
  text: string,
): Promise<void> {
  await mkdir(path.dirname(onboarding.openWikiOnboardingPath), {
    recursive: true,
  });
  await writeFile(onboarding.openWikiOnboardingPath, text, "utf8");
}

// Writes INSTRUCTIONS.md under the temp home without going through
// saveOpenWikiOnboardingConfig, so tests can control the raw file contents.
async function seedHomeInstructions(
  onboarding: Awaited<ReturnType<typeof loadOnboardingModule>>,
  contents: string,
): Promise<void> {
  await mkdir(path.dirname(onboarding.openWikiInstructionsPath), {
    recursive: true,
  });
  await writeFile(onboarding.openWikiInstructionsPath, contents, "utf8");
}

afterEach(async () => {
  vi.resetModules();

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalConfigDir === undefined) {
    delete process.env.OPENWIKI_CONFIG_DIR;
  } else {
    process.env.OPENWIKI_CONFIG_DIR = originalConfigDir;
  }

  await Promise.all(
    tempHomes
      .splice(0)
      .map((home) => rm(home, { force: true, recursive: true })),
  );
});

describe("OpenWiki onboarding instructions", () => {
  test("saves wiki instructions to INSTRUCTIONS.md instead of onboarding.json", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);

    await onboarding.saveOpenWikiOnboardingConfig({
      ingestionSchedule: {
        description: "daily",
        expression: "0 9 * * *",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      sourceInstances: [],
      sources: {},
      version: 1,
      wikiGoal: "Track projects, commitments, and recurring themes.",
    });

    const json = JSON.parse(
      await readFile(onboarding.openWikiOnboardingPath, "utf8"),
    ) as Record<string, unknown>;
    const instructions = await readFile(
      onboarding.openWikiInstructionsPath,
      "utf8",
    );

    expect(json.wikiGoal).toBeUndefined();
    expect(instructions).toBe(
      "Track projects, commitments, and recurring themes.\n",
    );
  });

  test("reads wiki instructions only from INSTRUCTIONS.md", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);

    await onboarding.saveOpenWikiOnboardingConfig({
      sourceInstances: [],
      sources: {},
      version: 1,
      wikiGoal: "Markdown instructions win.",
    });
    await writeFile(
      onboarding.openWikiOnboardingPath,
      `${JSON.stringify({
        sourceInstances: [],
        sources: {},
        version: 1,
        wikiGoal: "Legacy JSON fallback.",
      })}\n`,
      "utf8",
    );

    await expect(
      onboarding.readOpenWikiOnboardingConfig(),
    ).resolves.toMatchObject({
      wikiGoal: "Markdown instructions win.",
    });

    await rm(onboarding.openWikiInstructionsPath);

    const config = await onboarding.readOpenWikiOnboardingConfig();
    expect(config.wikiGoal).toBeUndefined();
  });

  test("saves repository wiki instructions under openwiki", async () => {
    const home = await createTempHome();
    const repo = await mkdtemp(path.join(tmpdir(), "openwiki-repo-"));
    const onboarding = await loadOnboardingModule(home);

    try {
      await onboarding.saveRepositoryWikiInstructions(
        repo,
        "Shared repository brief.",
      );

      await expect(
        readFile(onboarding.getRepositoryWikiInstructionsPath(repo), "utf8"),
      ).resolves.toBe("Shared repository brief.\n");
      await expect(
        onboarding.readRepositoryWikiInstructions(repo),
      ).resolves.toBe("Shared repository brief.");
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });
});

describe("OpenWiki onboarding completion", () => {
  test("does not require a schedule for code mode", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);

    expect(
      onboarding.isOnboardingComplete({
        completedAt: "2026-01-01T00:00:00.000Z",
        modeId: "code",
        sourceInstances: [],
        sources: {},
        templateId: "code",
        version: 1,
        wikiGoal: "Maintain a code wiki.",
      }),
    ).toBe(true);
  });

  test("checks repository instructions for completed code mode", async () => {
    const home = await createTempHome();
    const repo = await mkdtemp(path.join(tmpdir(), "openwiki-repo-"));
    const onboarding = await loadOnboardingModule(home);

    try {
      await onboarding.saveOpenWikiOnboardingConfig({
        completedAt: "2026-01-01T00:00:00.000Z",
        modeId: "code",
        sourceInstances: [],
        sources: {},
        templateId: "code",
        version: 1,
      });

      expect(onboarding.isRepositoryCodeOnboardingCompleteSync(repo)).toBe(
        false,
      );

      await onboarding.saveRepositoryWikiInstructions(
        repo,
        "Maintain a shared code wiki.",
      );

      expect(onboarding.isRepositoryCodeOnboardingCompleteSync(repo)).toBe(
        true,
      );
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("still requires a schedule for personal mode", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);

    expect(
      onboarding.isOnboardingComplete({
        completedAt: "2026-01-01T00:00:00.000Z",
        modeId: "personal",
        sourceInstances: [],
        sources: {},
        templateId: "personal",
        version: 1,
        wikiGoal: "Track projects and commitments.",
      }),
    ).toBe(false);
  });
});

describe("normalizeOnboardingConfig (via readOpenWikiOnboardingConfig)", () => {
  test("falls back to an empty config when the stored JSON is not an object", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);
    // Valid JSON, but an array rather than an object: it must not leak through.
    await seedRawOnboardingJson(onboarding, ["not", "an", "object"]);

    const config = await onboarding.readOpenWikiOnboardingConfig();

    expect(config.sourceInstances).toEqual([]);
    expect(config.sources).toEqual({});
    expect(config.version).toBe(1);
  });

  test("migrates a legacy sources map into sourceInstances", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);
    await seedRawOnboardingJson(onboarding, {
      sourceInstances: [],
      sources: { hackernews: { ingestionGoal: "top stories" } },
      version: 1,
    });

    const config = await onboarding.readOpenWikiOnboardingConfig();

    expect(config.sourceInstances).toEqual([
      {
        connectorId: "hackernews",
        id: "hackernews",
        ingestionGoal: "top stories",
      },
    ]);
    // sources is re-derived from the instances, so the goal round-trips back.
    expect(config.sources.hackernews?.ingestionGoal).toBe("top stories");
  });

  test("drops sources whose connector id is not recognized", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);
    // langsmith is a ConnectorId in the type but is intentionally absent from
    // isKnownConnectorId, so it must be discarded during normalization.
    await seedRawOnboardingJson(onboarding, {
      sourceInstances: [],
      sources: {
        langsmith: { ingestionGoal: "traces" },
        notion: { ingestionGoal: "docs" },
      },
      version: 1,
    });

    const config = await onboarding.readOpenWikiOnboardingConfig();
    const ids = config.sourceInstances.map(
      (sourceConfig) => sourceConfig.connectorId,
    );

    expect(ids).toContain("notion");
    expect(ids).not.toContain("langsmith");
  });

  test("backfills modeId and modeName from templateId and templateName", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);
    await seedRawOnboardingJson(onboarding, {
      sourceInstances: [],
      sources: {},
      templateId: "code",
      templateName: "Code repository",
      version: 1,
    });

    const config = await onboarding.readOpenWikiOnboardingConfig();

    expect(config.modeId).toBe("code");
    expect(config.modeName).toBe("Code repository");
    expect(config.templateId).toBe("code");
  });

  test("generates a source instance id when one is missing", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);
    await seedRawOnboardingJson(onboarding, {
      sourceInstances: [{ connectorId: "slack" }],
      sources: {},
      version: 1,
    });

    const config = await onboarding.readOpenWikiOnboardingConfig();

    expect(config.sourceInstances).toHaveLength(1);
    expect(config.sourceInstances[0]?.id).toBe("slack-1");
  });

  test("promotes a per-source schedule to the ingestion schedule and strips it from the instance", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);
    await seedRawOnboardingJson(onboarding, {
      sourceInstances: [
        {
          connectorId: "x",
          id: "x-1",
          schedule: {
            description: "nightly",
            expression: "0 3 * * *",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      ],
      sources: {},
      version: 1,
    });

    const config = await onboarding.readOpenWikiOnboardingConfig();

    expect(config.ingestionSchedule?.expression).toBe("0 3 * * *");
    expect(config.sourceInstances[0]?.schedule).toBeUndefined();
  });

  test("normalizes a pmset power schedule and fills defaults for missing fields", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);
    await seedRawOnboardingJson(onboarding, {
      powerManagement: { pmset: { enabled: true } },
      sourceInstances: [],
      sources: {},
      version: 1,
    });

    const config = await onboarding.readOpenWikiOnboardingConfig();

    expect(config.powerManagement?.pmset).toEqual({
      days: "",
      enabled: true,
      sleepTime: "",
      updatedAt: new Date(0).toISOString(),
      wakeTime: "",
    });
  });

  test("drops power management that has no pmset block", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);
    await seedRawOnboardingJson(onboarding, {
      powerManagement: { somethingElse: true },
      sourceInstances: [],
      sources: {},
      version: 1,
    });

    const config = await onboarding.readOpenWikiOnboardingConfig();

    expect(config.powerManagement).toBeUndefined();
  });

  test("ignores a sources value that is not an object", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);
    await seedRawOnboardingJson(onboarding, {
      sourceInstances: [],
      sources: "not-an-object",
      version: 1,
    });

    const config = await onboarding.readOpenWikiOnboardingConfig();

    expect(config.sources).toEqual({});
    expect(config.sourceInstances).toEqual([]);
  });

  test("ignores a sourceInstances value that is not an array", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);
    await seedRawOnboardingJson(onboarding, {
      sourceInstances: "not-an-array",
      sources: {},
      version: 1,
    });

    const config = await onboarding.readOpenWikiOnboardingConfig();

    expect(config.sourceInstances).toEqual([]);
  });

  test("preserves modeName and templateName when both are present", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);
    await seedRawOnboardingJson(onboarding, {
      modeId: "personal",
      modeName: "Personal wiki",
      sourceInstances: [],
      sources: {},
      templateId: "personal",
      templateName: "Personal template",
      version: 1,
    });

    const config = await onboarding.readOpenWikiOnboardingConfig();

    expect(config.modeName).toBe("Personal wiki");
    expect(config.templateName).toBe("Personal template");
  });

  test("skips malformed and unknown source instances", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);
    await seedRawOnboardingJson(onboarding, {
      sourceInstances: [
        null,
        "not-an-object",
        { name: "missing connector id" },
        { connectorId: "totally-bogus" },
        { connectorId: "notion", id: "keep-me" },
      ],
      sources: {},
      version: 1,
    });

    const config = await onboarding.readOpenWikiOnboardingConfig();

    expect(config.sourceInstances).toHaveLength(1);
    expect(config.sourceInstances[0]?.connectorId).toBe("notion");
    expect(config.sourceInstances[0]?.id).toBe("keep-me");
  });

  test("retains a source instance name when it is a string", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);
    await seedRawOnboardingJson(onboarding, {
      sourceInstances: [
        { connectorId: "notion", id: "notion-1", name: "Team space" },
      ],
      sources: {},
      version: 1,
    });

    const config = await onboarding.readOpenWikiOnboardingConfig();

    expect(config.sourceInstances[0]?.name).toBe("Team space");
  });

  test("normalizes full source connection fields", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);
    await seedRawOnboardingJson(onboarding, {
      sourceInstances: [
        {
          connectedAt: "2026-01-01T00:00:00.000Z",
          connectorConfig: { token: "abc" },
          connectorId: "notion",
          id: "notion-1",
          ingestionGoal: "docs",
        },
      ],
      sources: {},
      version: 1,
    });

    const config = await onboarding.readOpenWikiOnboardingConfig();

    expect(config.sourceInstances[0]).toMatchObject({
      connectedAt: "2026-01-01T00:00:00.000Z",
      connectorConfig: { token: "abc" },
      ingestionGoal: "docs",
    });
    // Legacy sources should carry the same connection details forward.
    expect(config.sources.notion).toMatchObject({
      connectedAt: "2026-01-01T00:00:00.000Z",
      connectorConfig: { token: "abc" },
      ingestionGoal: "docs",
    });
  });

  test("derives a single legacy source entry from duplicate connector instances", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);
    await seedRawOnboardingJson(onboarding, {
      sourceInstances: [
        { connectorId: "slack", id: "slack-1", ingestionGoal: "primary" },
        { connectorId: "slack", id: "slack-2", ingestionGoal: "secondary" },
      ],
      sources: {},
      version: 1,
    });

    const config = await onboarding.readOpenWikiOnboardingConfig();

    expect(config.sourceInstances).toHaveLength(2);
    // deriveLegacySources keeps only the first instance per connector id.
    expect(config.sources.slack?.ingestionGoal).toBe("primary");
  });

  test("fills schedule defaults when the schedule object is empty", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);
    await seedRawOnboardingJson(onboarding, {
      ingestionSchedule: {},
      sourceInstances: [],
      sources: {},
      version: 1,
    });

    const config = await onboarding.readOpenWikiOnboardingConfig();

    expect(config.ingestionSchedule).toEqual({
      description: "",
      expression: "",
      launchAgentPath: undefined,
      pausedAt: undefined,
      updatedAt: new Date(0).toISOString(),
      warning: undefined,
    });
  });

  test("preserves every optional schedule field when present", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);
    await seedRawOnboardingJson(onboarding, {
      ingestionSchedule: {
        description: "nightly",
        expression: "0 3 * * *",
        launchAgentPath: "/Library/LaunchAgents/openwiki.plist",
        pausedAt: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        warning: "battery only",
      },
      sourceInstances: [],
      sources: {},
      version: 1,
    });

    const config = await onboarding.readOpenWikiOnboardingConfig();

    expect(config.ingestionSchedule).toEqual({
      description: "nightly",
      expression: "0 3 * * *",
      launchAgentPath: "/Library/LaunchAgents/openwiki.plist",
      pausedAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      warning: "battery only",
    });
  });

  test("preserves every optional pmset field when present", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);
    await seedRawOnboardingJson(onboarding, {
      powerManagement: {
        pmset: {
          days: "MTWRF",
          enabled: true,
          sleepTime: "23:00:00",
          updatedAt: "2026-01-01T00:00:00.000Z",
          wakeTime: "07:00:00",
          warning: "requires admin",
        },
      },
      sourceInstances: [],
      sources: {},
      version: 1,
    });

    const config = await onboarding.readOpenWikiOnboardingConfig();

    expect(config.powerManagement?.pmset).toEqual({
      days: "MTWRF",
      enabled: true,
      sleepTime: "23:00:00",
      updatedAt: "2026-01-01T00:00:00.000Z",
      wakeTime: "07:00:00",
      warning: "requires admin",
    });
  });
});

describe("readOpenWikiOnboardingConfig missing and error paths", () => {
  test("returns an empty config with the wiki goal when only instructions exist", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);
    await seedHomeInstructions(onboarding, "Only the goal survives.\n");

    const config = await onboarding.readOpenWikiOnboardingConfig();

    expect(config.wikiGoal).toBe("Only the goal survives.");
    expect(config.sourceInstances).toEqual([]);
    expect(config.sources).toEqual({});
    expect(config.version).toBe(1);
  });

  test("returns a bare empty config when neither file exists", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);

    const config = await onboarding.readOpenWikiOnboardingConfig();

    expect(config).toEqual({
      sourceInstances: [],
      sources: {},
      version: 1,
    });
  });

  test("treats a whitespace-only instructions file as no wiki goal", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);
    await seedRawOnboardingJson(onboarding, {
      sourceInstances: [],
      sources: {},
      version: 1,
    });
    await seedHomeInstructions(onboarding, "   \n\t\n");

    const config = await onboarding.readOpenWikiOnboardingConfig();

    expect(config.wikiGoal).toBeUndefined();
  });

  test("rethrows when the stored onboarding JSON is malformed", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);
    await seedRawOnboardingText(onboarding, "{ not valid json");

    await expect(onboarding.readOpenWikiOnboardingConfig()).rejects.toThrow();
  });

  test("rethrows non-ENOENT errors from the instructions file", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);
    await seedRawOnboardingJson(onboarding, {
      sourceInstances: [],
      sources: {},
      version: 1,
    });
    // A directory at the instructions path makes readFile fail with EISDIR,
    // which is not treated as file-not-found and must propagate.
    await mkdir(onboarding.openWikiInstructionsPath, { recursive: true });

    await expect(onboarding.readOpenWikiOnboardingConfig()).rejects.toThrow();
  });
});

describe("readRepositoryWikiInstructions edge cases", () => {
  test("returns undefined when the repository has no instructions file", async () => {
    const home = await createTempHome();
    const repo = await mkdtemp(path.join(tmpdir(), "openwiki-repo-"));
    const onboarding = await loadOnboardingModule(home);

    try {
      await expect(
        onboarding.readRepositoryWikiInstructions(repo),
      ).resolves.toBeUndefined();
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("returns undefined for a whitespace-only repository instructions file", async () => {
    const home = await createTempHome();
    const repo = await mkdtemp(path.join(tmpdir(), "openwiki-repo-"));
    const onboarding = await loadOnboardingModule(home);

    try {
      const instructionsPath =
        onboarding.getRepositoryWikiInstructionsPath(repo);
      await mkdir(path.dirname(instructionsPath), { recursive: true });
      await writeFile(instructionsPath, "   \n", "utf8");

      await expect(
        onboarding.readRepositoryWikiInstructions(repo),
      ).resolves.toBeUndefined();
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("rethrows non-ENOENT errors from the repository instructions file", async () => {
    const home = await createTempHome();
    const repo = await mkdtemp(path.join(tmpdir(), "openwiki-repo-"));
    const onboarding = await loadOnboardingModule(home);

    try {
      // A directory at the instructions path yields EISDIR, not ENOENT.
      await mkdir(onboarding.getRepositoryWikiInstructionsPath(repo), {
        recursive: true,
      });

      await expect(
        onboarding.readRepositoryWikiInstructions(repo),
      ).rejects.toThrow();
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });
});

describe("isOnboardingComplete code mode via templateId", () => {
  test("treats a templateId of code as code mode when modeId is absent", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);

    expect(
      onboarding.isOnboardingComplete({
        completedAt: "2026-01-01T00:00:00.000Z",
        sourceInstances: [],
        sources: {},
        templateId: "code",
        version: 1,
        wikiGoal: "Maintain a code wiki.",
      }),
    ).toBe(true);
  });
});

describe("isOpenWikiOnboardingCompleteSync", () => {
  test("returns false when no onboarding.json exists", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);

    expect(onboarding.isOpenWikiOnboardingCompleteSync()).toBe(false);
  });

  test("returns true for a completed personal config with a schedule", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);

    await onboarding.saveOpenWikiOnboardingConfig({
      completedAt: "2026-01-01T00:00:00.000Z",
      ingestionSchedule: {
        description: "daily",
        expression: "0 9 * * *",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      modeId: "personal",
      sourceInstances: [],
      sources: {},
      templateId: "personal",
      version: 1,
      wikiGoal: "Track projects and commitments.",
    });

    expect(onboarding.isOpenWikiOnboardingCompleteSync()).toBe(true);
  });

  test("returns false when the instructions file is missing", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);

    await onboarding.saveOpenWikiOnboardingConfig({
      completedAt: "2026-01-01T00:00:00.000Z",
      ingestionSchedule: {
        description: "daily",
        expression: "0 9 * * *",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      modeId: "personal",
      sourceInstances: [],
      sources: {},
      templateId: "personal",
      version: 1,
      wikiGoal: "Track projects and commitments.",
    });
    await rm(onboarding.openWikiInstructionsPath);

    expect(onboarding.isOpenWikiOnboardingCompleteSync()).toBe(false);
  });

  test("returns false when the instructions file is only whitespace", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);

    await onboarding.saveOpenWikiOnboardingConfig({
      completedAt: "2026-01-01T00:00:00.000Z",
      ingestionSchedule: {
        description: "daily",
        expression: "0 9 * * *",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      modeId: "personal",
      sourceInstances: [],
      sources: {},
      templateId: "personal",
      version: 1,
      wikiGoal: "Track projects and commitments.",
    });
    await seedHomeInstructions(onboarding, "   \n");

    expect(onboarding.isOpenWikiOnboardingCompleteSync()).toBe(false);
  });

  test("returns false when onboarding.json is malformed", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);
    await seedRawOnboardingText(onboarding, "{ not valid json");

    expect(onboarding.isOpenWikiOnboardingCompleteSync()).toBe(false);
  });
});

describe("isRepositoryCodeOnboardingCompleteSync edge cases", () => {
  test("returns false when no onboarding.json exists", async () => {
    const home = await createTempHome();
    const repo = await mkdtemp(path.join(tmpdir(), "openwiki-repo-"));
    const onboarding = await loadOnboardingModule(home);

    try {
      expect(onboarding.isRepositoryCodeOnboardingCompleteSync(repo)).toBe(
        false,
      );
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("returns false for a non-code onboarding config", async () => {
    const home = await createTempHome();
    const repo = await mkdtemp(path.join(tmpdir(), "openwiki-repo-"));
    const onboarding = await loadOnboardingModule(home);

    try {
      await onboarding.saveOpenWikiOnboardingConfig({
        completedAt: "2026-01-01T00:00:00.000Z",
        modeId: "personal",
        sourceInstances: [],
        sources: {},
        templateId: "personal",
        version: 1,
      });
      await onboarding.saveRepositoryWikiInstructions(repo, "A code wiki.");

      expect(onboarding.isRepositoryCodeOnboardingCompleteSync(repo)).toBe(
        false,
      );
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("returns false when the repository instructions are only whitespace", async () => {
    const home = await createTempHome();
    const repo = await mkdtemp(path.join(tmpdir(), "openwiki-repo-"));
    const onboarding = await loadOnboardingModule(home);

    try {
      await onboarding.saveOpenWikiOnboardingConfig({
        completedAt: "2026-01-01T00:00:00.000Z",
        modeId: "code",
        sourceInstances: [],
        sources: {},
        templateId: "code",
        version: 1,
      });
      const instructionsPath =
        onboarding.getRepositoryWikiInstructionsPath(repo);
      await mkdir(path.dirname(instructionsPath), { recursive: true });
      await writeFile(instructionsPath, "   \n", "utf8");

      expect(onboarding.isRepositoryCodeOnboardingCompleteSync(repo)).toBe(
        false,
      );
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("returns false when onboarding.json is malformed", async () => {
    const home = await createTempHome();
    const repo = await mkdtemp(path.join(tmpdir(), "openwiki-repo-"));
    const onboarding = await loadOnboardingModule(home);

    try {
      await seedRawOnboardingText(onboarding, "{ not valid json");

      expect(onboarding.isRepositoryCodeOnboardingCompleteSync(repo)).toBe(
        false,
      );
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });
});
