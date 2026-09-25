import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createEmptyOnboardingConfig } from "../../src/setup/onboarding.ts";
import type { OpenWikiOnboardingConfig } from "../../src/setup/onboarding.ts";
import {
  deleteConnectorSchedules,
  installConnectorSchedule,
  installOpenWikiPowerSchedule,
  listConnectorSchedules,
  pauseConnectorSchedules,
  resumeConnectorSchedules,
} from "../../src/scheduling/schedules.ts";

// These exercise the reachable, non-shelling surface of the schedule lifecycle
// helpers. Two techniques keep them off child_process:
//  1. Some branches (invalid cron, "no representable power window") return
//     before any platform check, so they are pure on every host as-is. The
//     "too complex" branch sits after the darwin guard, so that test stubs the
//     platform to darwin to reach it (still returns before shelling).
//  2. The native paths guard on `process.platform === "darwin"`; on every other
//     platform launchctl/pmset/unload/remove are documented no-ops. We stub the
//     platform to a non-Darwin value to drive the graceful-degradation paths and
//     the pure wake-window computation without spawning launchctl or osascript.
// The launchctl/crontab/osascript success paths themselves are left for
// integration tests, as the existing suite notes.

const ORIGINAL_PLATFORM = process.platform;

/**
 * Reassigns `process.platform` for the duration of a test. schedules.ts reads
 * it at call time, so this reliably selects the non-Darwin no-op behavior.
 */
function stubPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value,
  });
}

let tempDirs: string[] = [];

afterEach(async () => {
  // Always restore the real platform so one test's stub can't leak into the
  // next (or into the shared, macOS-real suite).
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: ORIGINAL_PLATFORM,
  });

  await Promise.all(
    tempDirs.map((dir) => rm(dir, { force: true, recursive: true })),
  );
  tempDirs = [];
});

/**
 * Builds an onboarding config carrying a single ingestion schedule, overriding
 * only the fields a test cares about.
 */
function configWithSchedule(
  expression: string,
  overrides: Partial<OpenWikiOnboardingConfig["ingestionSchedule"]> = {},
): OpenWikiOnboardingConfig {
  return {
    ...createEmptyOnboardingConfig(),
    ingestionSchedule: {
      description: "All ingestion",
      expression,
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    },
  };
}

describe("installConnectorSchedule", () => {
  test("throws the validation error for an unparseable cron before touching the system", async () => {
    await expect(
      installConnectorSchedule({
        connectorId: "git-repo",
        cronExpression: "not a cron",
        cwd: "/repo",
      }),
    ).rejects.toThrow();
  });

  test("returns a 'too complex for launchd' warning for a valid-but-unrepresentable cron", async () => {
    // The darwin guard precedes the representability check, so on a non-Darwin
    // host this would return the "macOS-only" warning instead. Force darwin so
    // the too-complex branch is reached regardless of the CI host OS.
    stubPlatform("darwin");

    // `*/15 2 * * *` parses as cron but has no single-value launchd calendar
    // interval, so install must degrade to a saved-only warning rather than
    // writing a plist. This branch returns before any shelling.
    const result = await installConnectorSchedule({
      connectorId: "git-repo",
      cronExpression: "*/15 2 * * *",
      cwd: "/repo",
    });

    expect(result.expression).toBe("*/15 2 * * *");
    expect(result.launchAgentPath).toBeUndefined();
    expect(result.warning).toMatch(/too complex/i);
    expect(result.description.length).toBeGreaterThan(0);
  });

  test("saves without native install on non-macOS platforms", async () => {
    stubPlatform("linux");

    const result = await installConnectorSchedule({
      connectorId: "git-repo",
      cronExpression: "0 2 * * *",
      cwd: "/repo",
    });

    expect(result.expression).toBe("0 2 * * *");
    expect(result.launchAgentPath).toBeUndefined();
    expect(result.warning).toMatch(/macOS-only/i);
  });
});

describe("installOpenWikiPowerSchedule", () => {
  test("skips when no schedule is saved", async () => {
    const result = await installOpenWikiPowerSchedule(
      createEmptyOnboardingConfig(),
    );

    expect(result.enabled).toBe(false);
    expect(result.wakeTime).toBe("");
    expect(result.warning).toMatch(/no saved schedules/i);
  });

  test("skips when the schedule cannot be a simple repeat window (day-of-month restricted)", async () => {
    const result = await installOpenWikiPowerSchedule(
      configWithSchedule("0 2 5 * *"),
    );

    expect(result.enabled).toBe(false);
    expect(result.warning).toMatch(/no saved schedules/i);
  });

  test("skips when the expression has the wrong number of cron fields", async () => {
    // A malformed expression fails parseSimpleCronFields inside
    // parseRepeatScheduleTime, so no repeat window can be derived.
    const result = await installOpenWikiPowerSchedule(
      configWithSchedule("0 2 *"),
    );

    expect(result.enabled).toBe(false);
    expect(result.warning).toMatch(/no saved schedules/i);
  });

  test("skips when the minute field is a step it cannot pin to a wake time", async () => {
    // `*/5` is not a single minute, so parseRepeatScheduleTime returns null even
    // though day and month are wildcards.
    const result = await installOpenWikiPowerSchedule(
      configWithSchedule("*/5 2 * * *"),
    );

    expect(result.enabled).toBe(false);
    expect(result.warning).toMatch(/no saved schedules/i);
  });

  test("skips when weekday is a range that maps to no single pmset day", async () => {
    // `1-5` is not a single weekday number, so parsePmsetDays yields null and
    // the whole window is rejected.
    const result = await installOpenWikiPowerSchedule(
      configWithSchedule("0 2 * * 1-5"),
    );

    expect(result.enabled).toBe(false);
    expect(result.warning).toMatch(/no saved schedules/i);
  });

  test("skips when the computed wake time would fall before midnight", async () => {
    // Midnight run: wake = 0 - 2 minutes < 0, which cannot be expressed as a
    // same-day repeat wake, so the window is rejected.
    const result = await installOpenWikiPowerSchedule(
      configWithSchedule("0 0 * * *"),
    );

    expect(result.enabled).toBe(false);
    expect(result.warning).toMatch(/no saved schedules/i);
  });

  test("skips when the computed sleep time would spill past midnight", async () => {
    // 23:55 run: sleep = 1435 + 30 = 1465 >= 1440, past midnight, so rejected.
    const result = await installOpenWikiPowerSchedule(
      configWithSchedule("55 23 * * *"),
    );

    expect(result.enabled).toBe(false);
    expect(result.warning).toMatch(/no saved schedules/i);
  });

  test("computes a wake/sleep window (with default days) but does not install off macOS", async () => {
    stubPlatform("linux");

    // 02:00 daily -> wake 2 min earlier, sleep 30 min later, all seven days.
    const result = await installOpenWikiPowerSchedule(
      configWithSchedule("0 2 * * *"),
    );

    expect(result).toEqual({
      days: "MTWRFSU",
      enabled: false,
      sleepTime: "02:30:00",
      wakeTime: "01:58:00",
      warning: "Wake setup is currently macOS-only.",
    });
  });

  test.each([
    ["0", "U"],
    ["1", "M"],
    ["2", "T"],
    ["3", "W"],
    ["4", "R"],
    ["5", "F"],
    ["6", "S"],
    ["7", "U"],
  ])(
    "maps cron weekday %s to pmset day %s in the wake window",
    async (weekday, pmsetDay) => {
      stubPlatform("linux");

      // 04:00 keeps wake (03:58) and sleep (04:30) inside the same day for every
      // weekday, isolating the weekday-to-pmset-letter mapping (7 normalizes to
      // Sunday just like 0).
      const result = await installOpenWikiPowerSchedule(
        configWithSchedule(`0 4 * * ${weekday}`),
      );

      expect(result.days).toBe(pmsetDay);
      expect(result.wakeTime).toBe("03:58:00");
      expect(result.sleepTime).toBe("04:30:00");
    },
  );
});

describe("listConnectorSchedules", () => {
  test("returns an empty list when nothing is scheduled", async () => {
    expect(await listConnectorSchedules(createEmptyOnboardingConfig())).toEqual(
      [],
    );
  });

  test("reports a paused schedule as unloaded without probing launchctl", async () => {
    // A paused schedule short-circuits the loaded check, so this holds on any
    // platform and never shells out.
    const config = configWithSchedule("0 2 * * *", {
      pausedAt: "2026-01-02T00:00:00.000Z",
      warning: "some warning",
    });

    const [status] = await listConnectorSchedules(config);

    expect(status).toMatchObject({
      displayName: "All ingestion",
      expression: "0 2 * * *",
      launchAgentLoaded: false,
      launchAgentPlistExists: false,
      pausedAt: "2026-01-02T00:00:00.000Z",
      sourceInstanceId: "all",
      warning: "some warning",
    });
    expect(status.launchAgentPath).toBeUndefined();
  });

  test("checks plist existence on disk and treats non-Darwin as never loaded", async () => {
    stubPlatform("linux");

    const dir = await mkdtemp(path.join(os.tmpdir(), "openwiki-sched-"));
    tempDirs.push(dir);
    const plistPath = path.join(dir, "agent.plist");
    await writeFile(plistPath, "<plist/>", "utf8");

    const present = await listConnectorSchedules(
      configWithSchedule("0 2 * * *", { launchAgentPath: plistPath }),
    );
    expect(present[0].launchAgentLoaded).toBe(false);
    expect(present[0].launchAgentPlistExists).toBe(true);

    const absent = await listConnectorSchedules(
      configWithSchedule("0 2 * * *", {
        launchAgentPath: path.join(dir, "missing.plist"),
      }),
    );
    expect(absent[0].launchAgentPlistExists).toBe(false);
  });
});

describe("pauseConnectorSchedules", () => {
  test("skips a non-'all' target and reports it as skipped", async () => {
    const config = configWithSchedule("0 2 * * *");

    expect(await pauseConnectorSchedules(config, "git-repo")).toEqual({
      config,
      connectorIds: [],
      skippedConnectorIds: ["git-repo"],
      warnings: [],
    });
  });

  test("skips when there is no schedule to pause", async () => {
    const config = createEmptyOnboardingConfig();

    expect(await pauseConnectorSchedules(config, "all")).toEqual({
      config,
      connectorIds: [],
      skippedConnectorIds: ["all"],
      warnings: [],
    });
  });

  test("skips when the schedule is already paused", async () => {
    const config = configWithSchedule("0 2 * * *", {
      pausedAt: "2026-01-02T00:00:00.000Z",
    });

    const result = await pauseConnectorSchedules(config, "all");
    expect(result.skippedConnectorIds).toEqual(["all"]);
    expect(result.connectorIds).toEqual([]);
  });

  test("stamps pausedAt and skips native unload off macOS", async () => {
    stubPlatform("linux");

    const config = configWithSchedule("0 2 * * *");
    const result = await pauseConnectorSchedules(config, "all");

    expect(result.connectorIds).toEqual(["all"]);
    expect(result.skippedConnectorIds).toEqual([]);
    expect(result.config.ingestionSchedule?.pausedAt).toEqual(
      expect.any(String),
    );
    // No saved pmset means power reconciliation is a no-op.
    expect(result.powerSchedule).toBeUndefined();
  });
});

describe("resumeConnectorSchedules", () => {
  test("skips when the schedule is not paused", async () => {
    const config = configWithSchedule("0 2 * * *");

    const result = await resumeConnectorSchedules({
      config,
      cwd: "/repo",
      target: "all",
    });
    expect(result.skippedConnectorIds).toEqual(["all"]);
    expect(result.connectorIds).toEqual([]);
  });

  test("clears pausedAt and surfaces the non-macOS install warning", async () => {
    stubPlatform("linux");

    const config = configWithSchedule("0 2 * * *", {
      pausedAt: "2026-01-02T00:00:00.000Z",
    });
    const result = await resumeConnectorSchedules({
      config,
      cwd: "/repo",
      target: "all",
    });

    expect(result.connectorIds).toEqual(["all"]);
    expect(result.config.ingestionSchedule?.pausedAt).toBeUndefined();
    expect(result.warnings).toContain(
      "Schedule saved, but native installation is currently macOS-only.",
    );
  });
});

describe("deleteConnectorSchedules", () => {
  test("skips when there is no schedule to delete", async () => {
    const config = createEmptyOnboardingConfig();

    expect(await deleteConnectorSchedules(config, "all")).toEqual({
      config,
      connectorIds: [],
      skippedConnectorIds: ["all"],
      warnings: [],
    });
  });

  test("removes the schedule and skips native cleanup off macOS", async () => {
    stubPlatform("linux");

    const config = configWithSchedule("0 2 * * *");
    const result = await deleteConnectorSchedules(config, "all");

    expect(result.connectorIds).toEqual(["all"]);
    expect(result.config.ingestionSchedule).toBeUndefined();
    expect(result.powerSchedule).toBeUndefined();
  });

  test("leaves an already-disabled power schedule untouched and mirrors legacy sources", async () => {
    stubPlatform("linux");

    // The saved pmset is already disabled, so with no ingestion schedule left
    // reconciliation returns early without shelling out or rewriting pmset. The
    // populated sourceInstances also drive cloneOnboardingConfig's legacy-source
    // derivation (the `sources` map is rebuilt from the instances).
    const base = configWithSchedule("0 2 * * *");
    const config: OpenWikiOnboardingConfig = {
      ...base,
      sourceInstances: [
        {
          connectedAt: "2026-01-01T00:00:00.000Z",
          connectorId: "git-repo",
          id: "git-repo-1",
          ingestionGoal: "index the repo",
        },
      ],
      powerManagement: {
        pmset: {
          days: "MTWRFSU",
          enabled: false,
          sleepTime: "02:30:00",
          updatedAt: "2026-01-01T00:00:00.000Z",
          wakeTime: "01:58:00",
        },
      },
    };

    const result = await deleteConnectorSchedules(config, "all");

    expect(result.config.ingestionSchedule).toBeUndefined();
    expect(result.powerSchedule).toBeUndefined();
    expect(result.config.powerManagement?.pmset?.enabled).toBe(false);
    expect(result.config.sources["git-repo"]).toEqual({
      connectedAt: "2026-01-01T00:00:00.000Z",
      connectorConfig: undefined,
      ingestionGoal: "index the repo",
    });
  });

  test("cancels a saved-and-enabled power schedule when the last schedule is deleted", async () => {
    stubPlatform("linux");

    // With a pmset schedule marked enabled and no ingestion schedule left, power
    // reconciliation must flip it off. Off macOS the cancel is a no-op that only
    // rewrites the saved state.
    const config: OpenWikiOnboardingConfig = {
      ...configWithSchedule("0 2 * * *"),
      powerManagement: {
        pmset: {
          days: "MTWRFSU",
          enabled: true,
          sleepTime: "02:30:00",
          updatedAt: "2026-01-01T00:00:00.000Z",
          wakeTime: "01:58:00",
        },
      },
    };

    const result = await deleteConnectorSchedules(config, "all");

    expect(result.config.ingestionSchedule).toBeUndefined();
    expect(result.powerSchedule?.enabled).toBe(false);
    expect(result.config.powerManagement?.pmset?.enabled).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
