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
});
