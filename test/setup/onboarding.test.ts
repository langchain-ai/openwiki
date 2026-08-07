import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalHome = process.env.HOME;
const tempHomes: string[] = [];

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-onboarding-"));
  tempHomes.push(home);
  return home;
}

async function loadOnboardingModule(home: string) {
  vi.resetModules();
  process.env.HOME = home;
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

afterEach(async () => {
  vi.resetModules();

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
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
});
