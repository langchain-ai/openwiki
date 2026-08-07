import { describe, expect, test } from "vitest";
import {
  formatPowerScheduleStatus,
  formatScheduleHeader,
  formatScheduleMutationResult,
  formatScheduleStatus,
} from "../../src/cli/schedule-format.ts";
import type {
  ConnectorScheduleStatus,
  PowerScheduleStatus,
  ScheduleMutationResult,
} from "../../src/scheduling/schedules.ts";

/**
 * Builds a ScheduleMutationResult, defaulting the fields the formatter does not
 * read (config) to an inert placeholder.
 */
function mutationResult(
  overrides: Partial<ScheduleMutationResult> = {},
): ScheduleMutationResult {
  return {
    config: {} as ScheduleMutationResult["config"],
    connectorIds: [],
    powerSchedule: undefined,
    skippedConnectorIds: [],
    warnings: [],
    ...overrides,
  };
}

/**
 * Builds a ConnectorScheduleStatus with sensible defaults for the fields under
 * test.
 */
function connectorStatus(
  overrides: Partial<ConnectorScheduleStatus> = {},
): ConnectorScheduleStatus {
  return {
    description: "Daily refresh",
    expression: "0 9 * * *",
    launchAgentLoaded: false,
    launchAgentPlistExists: false,
    sourceInstanceId: "src-1",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/**
 * Builds a PowerScheduleStatus with sensible defaults.
 */
function powerStatus(
  overrides: Partial<PowerScheduleStatus> = {},
): PowerScheduleStatus {
  return {
    days: "MTWRF",
    enabled: true,
    sleepTime: "23:00",
    updatedAt: "2026-01-01T00:00:00Z",
    wakeTime: "08:00",
    ...overrides,
  };
}

describe("formatScheduleMutationResult", () => {
  test("labels the action and lists changed connectors", () => {
    const result = formatScheduleMutationResult(
      "delete",
      mutationResult({ connectorIds: ["a", "b"] }),
    );

    expect(result).toContain("Deleted");
    expect(result).toContain("a, b");
    expect(result).toContain("Cron update");
  });

  test("uses the resume/pause labels", () => {
    expect(formatScheduleMutationResult("pause", mutationResult())).toContain(
      "Paused",
    );
    expect(formatScheduleMutationResult("resume", mutationResult())).toContain(
      "Resumed",
    );
  });

  test("reports none when there are no changed or skipped connectors", () => {
    const result = formatScheduleMutationResult("delete", mutationResult());

    expect(result).toContain("none");
  });

  test("includes the Mac wake row only when a power schedule is present", () => {
    const withPower = formatScheduleMutationResult(
      "delete",
      mutationResult({ powerSchedule: powerStatus({ enabled: true }) }),
    );
    expect(withPower).toContain("Mac wake");
    expect(withPower).toContain("configured");

    expect(
      formatScheduleMutationResult("delete", mutationResult()),
    ).not.toContain("Mac wake");
  });

  test("renders warnings when present", () => {
    const result = formatScheduleMutationResult(
      "delete",
      mutationResult({ warnings: ["heads up"] }),
    );

    expect(result).toContain("Warning : heads up");
  });
});

describe("formatScheduleHeader", () => {
  test("uses the singular form for one schedule", () => {
    expect(formatScheduleHeader(1)).toContain(
      "1 connector schedule configured",
    );
  });

  test("uses the plural form otherwise", () => {
    expect(formatScheduleHeader(0)).toContain(
      "0 connector schedules configured",
    );
    expect(formatScheduleHeader(3)).toContain(
      "3 connector schedules configured",
    );
  });
});

describe("formatPowerScheduleStatus", () => {
  test("renders a not-configured placeholder for a null schedule", () => {
    const result = formatPowerScheduleStatus(null);

    expect(result).toContain("Mac Wake Window");
    expect(result).toContain("Status : not configured");
  });

  test("renders the schedule details when enabled", () => {
    const result = formatPowerScheduleStatus(powerStatus());

    expect(result).toContain("Status  : configured");
    expect(result).toContain("Days    : MTWRF");
    expect(result).toContain("Wake    : 08:00");
    expect(result).toContain("Sleep   : 23:00");
  });

  test("shows disabled status and any warning", () => {
    const result = formatPowerScheduleStatus(
      powerStatus({ enabled: false, warning: "clock drift" }),
    );

    expect(result).toContain("disabled");
    expect(result).toContain("Warning");
    expect(result).toContain("clock drift");
  });
});

describe("formatScheduleStatus", () => {
  test("reports not installed when there is no launch agent path", () => {
    const result = formatScheduleStatus(connectorStatus());

    expect(result).toContain("Launchd");
    expect(result).toContain("not installed");
  });

  test("reports loaded when the launch agent is loaded", () => {
    const result = formatScheduleStatus(
      connectorStatus({
        launchAgentLoaded: true,
        launchAgentPath: "/tmp/agent.plist",
        launchAgentPlistExists: true,
      }),
    );

    expect(result).toContain("loaded");
    expect(result).toContain("/tmp/agent.plist");
  });

  test("reports paused when a pausedAt timestamp is present", () => {
    const result = formatScheduleStatus(
      connectorStatus({ pausedAt: "2026-01-02T00:00:00Z" }),
    );

    expect(result).toContain("paused");
    expect(result).toContain("Paused");
  });

  test("prefers the display name and shows the connector id when set", () => {
    const result = formatScheduleStatus(
      connectorStatus({ displayName: "My Source", connectorId: "conn-9" }),
    );

    expect(result).toContain("Source : My Source");
    expect(result).toContain("Connector : conn-9");
  });

  test("falls back to the source instance id without a display name", () => {
    const result = formatScheduleStatus(
      connectorStatus({ sourceInstanceId: "src-42" }),
    );

    expect(result).toContain("Source : src-42");
  });
});
