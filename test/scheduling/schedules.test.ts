import { describe, expect, test } from "vitest";
import { createEmptyOnboardingConfig } from "../../src/setup/onboarding.ts";
import {
  describeCronExpression,
  getSavedPowerScheduleStatus,
  getSuggestedCronExpression,
  validateCronExpression,
} from "../../src/scheduling/schedules.ts";

// These cover the pure, dependency-free surface of schedules.ts. The
// install/list/pause/resume/delete helpers shell out to launchctl/crontab and
// belong in integration tests, not here.

describe("validateCronExpression", () => {
  test("accepts a valid five-field expression and describes it", () => {
    const result = validateCronExpression("0 2 * * *");

    expect(result.valid).toBe(true);
    // Narrow the discriminated union so the description field is visible.
    if (result.valid) {
      expect(result.expression).toBe("0 2 * * *");
      expect(result.description).toMatch(/2:00 AM/i);
    }
  });

  test("collapses surrounding and repeated whitespace before validating", () => {
    const result = validateCronExpression("  0   2  *  *  *  ");

    expect(result.valid).toBe(true);
    expect(result.expression).toBe("0 2 * * *");
  });

  test("rejects an empty or whitespace-only expression with guidance", () => {
    for (const input of ["", "   "]) {
      expect(validateCronExpression(input)).toEqual({
        error: "Enter a cron expression like 0 2 * * *.",
        expression: "",
        valid: false,
      });
    }
  });

  test("rejects an unparseable expression and echoes back what was entered", () => {
    const result = validateCronExpression("not a cron");

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.expression).toBe("not a cron");
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});

describe("getSuggestedCronExpression", () => {
  test("returns the saved ingestion expression when one exists", () => {
    const config = {
      ...createEmptyOnboardingConfig(),
      ingestionSchedule: {
        description: "every morning",
        expression: "30 4 * * *",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };

    expect(getSuggestedCronExpression(config)).toBe("30 4 * * *");
  });

  test("falls back to a 2am daily default when no schedule is saved", () => {
    expect(getSuggestedCronExpression(createEmptyOnboardingConfig())).toBe(
      "0 2 * * *",
    );
  });
});

describe("describeCronExpression", () => {
  test("renders a human-readable, twelve-hour description", () => {
    expect(describeCronExpression("0 2 * * *")).toMatch(/2:00 AM/i);
  });

  test("throws on an unparseable expression rather than returning junk", () => {
    expect(() => describeCronExpression("not a cron")).toThrow();
  });
});

describe("getSavedPowerScheduleStatus", () => {
  test("returns null when no pmset schedule has been saved", () => {
    expect(
      getSavedPowerScheduleStatus(createEmptyOnboardingConfig()),
    ).toBeNull();
  });

  test("mirrors the saved pmset fields into a status object", () => {
    const config = {
      ...createEmptyOnboardingConfig(),
      powerManagement: {
        pmset: {
          days: "MTWRF",
          enabled: true,
          sleepTime: "23:30",
          updatedAt: "2026-01-02T00:00:00.000Z",
          wakeTime: "01:45",
          warning: "scheduled by OpenWiki",
        },
      },
    };

    expect(getSavedPowerScheduleStatus(config)).toEqual({
      days: "MTWRF",
      enabled: true,
      sleepTime: "23:30",
      updatedAt: "2026-01-02T00:00:00.000Z",
      wakeTime: "01:45",
      warning: "scheduled by OpenWiki",
    });
  });
});
