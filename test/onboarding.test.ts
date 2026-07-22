import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  return await import("../src/onboarding.ts");
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

describe("OpenWiki onboarding schedule migration", () => {
  test("migrates global ingestionSchedule to source instances", async () => {
    // Arrange
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);
    const globalSchedule = {
      description: "daily at 2am",
      expression: "0 2 * * *",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    // Write a config with a global ingestionSchedule and source instances without schedules
    await writeFile(
      onboarding.openWikiOnboardingPath,
      `${JSON.stringify({
        completedAt: "2026-01-01T00:00:00.000Z",
        ingestionSchedule: globalSchedule,
        sourceInstances: [
          {
            connectorId: "web-search",
            id: "web-search-1",
            connectedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            connectorId: "notion",
            id: "notion-1",
            connectedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        sources: {},
        version: 1,
      })}\n`,
      "utf8",
    );

    // Act
    const config = await onboarding.readOpenWikiOnboardingConfig();

    // Assert — both instances should now have the global schedule
    expect(config.sourceInstances[0].schedule).toEqual(globalSchedule);
    expect(config.sourceInstances[1].schedule).toEqual(globalSchedule);
  });

  test("preserves existing per-source schedules during migration", async () => {
    // Arrange
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);
    const globalSchedule = {
      description: "daily at 2am",
      expression: "0 2 * * *",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const perSourceSchedule = {
      description: "every hour",
      expression: "0 * * * *",
      updatedAt: "2026-06-01T00:00:00.000Z",
    };

    // Write a config with a global ingestionSchedule and one source with its own schedule
    await writeFile(
      onboarding.openWikiOnboardingPath,
      `${JSON.stringify({
        completedAt: "2026-01-01T00:00:00.000Z",
        ingestionSchedule: globalSchedule,
        sourceInstances: [
          {
            connectorId: "web-search",
            id: "web-search-1",
            connectedAt: "2026-01-01T00:00:00.000Z",
            schedule: perSourceSchedule,
          },
          {
            connectorId: "notion",
            id: "notion-1",
            connectedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        sources: {},
        version: 1,
      })}\n`,
      "utf8",
    );

    // Act
    const config = await onboarding.readOpenWikiOnboardingConfig();

    // Assert — web-search keeps its own schedule, notion gets the global one
    expect(config.sourceInstances[0].schedule).toEqual(perSourceSchedule);
    expect(config.sourceInstances[1].schedule).toEqual(globalSchedule);
  });

  test("preserves schedule field on source instances after save", async () => {
    // Arrange
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);
    const schedule = {
      description: "every hour",
      expression: "0 * * * *",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    // Act — save a config with a per-source schedule
    await onboarding.saveOpenWikiOnboardingConfig({
      completedAt: "2026-01-01T00:00:00.000Z",
      modeId: "personal",
      sourceInstances: [
        {
          connectorId: "web-search",
          id: "web-search-1",
          connectedAt: "2026-01-01T00:00:00.000Z",
          schedule,
        },
      ],
      sources: {},
      templateId: "personal",
      version: 1,
    });

    // Assert — read back and verify schedule is preserved
    const config = await onboarding.readOpenWikiOnboardingConfig();
    expect(config.sourceInstances[0].schedule).toEqual(schedule);
  });

  test("backfills global ingestionSchedule from first source instance with schedule", async () => {
    // Arrange
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);
    const perSourceSchedule = {
      description: "every hour",
      expression: "0 * * * *",
      updatedAt: "2026-06-01T00:00:00.000Z",
    };

    // Write a config with NO global ingestionSchedule but a source instance with a schedule
    await writeFile(
      onboarding.openWikiOnboardingPath,
      `${JSON.stringify({
        completedAt: "2026-01-01T00:00:00.000Z",
        sourceInstances: [
          {
            connectorId: "web-search",
            id: "web-search-1",
            connectedAt: "2026-01-01T00:00:00.000Z",
            schedule: perSourceSchedule,
          },
        ],
        sources: {},
        version: 1,
      })}\n`,
      "utf8",
    );

    // Act
    const config = await onboarding.readOpenWikiOnboardingConfig();

    // Assert — global ingestionSchedule should be backfilled from the first source
    expect(config.ingestionSchedule).toEqual(perSourceSchedule);
  });
});
