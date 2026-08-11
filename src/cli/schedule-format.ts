import type {
  ConnectorScheduleStatus,
  PowerScheduleStatus,
  ScheduleMutationResult,
} from "../scheduling/schedules.js";

/**
 * Formats the outcome of a delete/pause/resume schedule mutation into a
 * bordered summary listing the changed and skipped connectors, any Mac wake
 * configuration, and warnings.
 */
export function formatScheduleMutationResult(
  action: "delete" | "pause" | "resume",
  result: ScheduleMutationResult,
): string {
  const actionLabel =
    action === "delete" ? "Deleted" : action === "pause" ? "Paused" : "Resumed";
  const changed =
    result.connectorIds.length > 0 ? result.connectorIds.join(", ") : "none";
  const skipped =
    result.skippedConnectorIds.length > 0
      ? result.skippedConnectorIds.join(", ")
      : "none";
  const rows = [
    [`${actionLabel}`, changed],
    ["Skipped", skipped],
  ];

  if (result.powerSchedule) {
    rows.push([
      "Mac wake",
      result.powerSchedule.enabled ? "configured" : "not configured",
    ]);
  }

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const body = rows
    .map(([label, value]) => `  ${label.padEnd(labelWidth)} : ${value}`)
    .join("\n");
  const warnings =
    result.warnings.length > 0
      ? `\n${result.warnings.map((warning) => `  Warning : ${warning}`).join("\n")}`
      : "";

  return ["", "Cron update", "-----------", body + warnings, ""].join("\n");
}

/**
 * Formats the banner shown above a schedule listing, pluralizing the count.
 */
export function formatScheduleHeader(scheduleCount: number): string {
  const title = "OpenWiki Schedules";
  const summary =
    scheduleCount === 1
      ? "1 connector schedule configured"
      : `${scheduleCount} connector schedules configured`;

  return [
    "",
    "=".repeat(title.length),
    title,
    "=".repeat(title.length),
    summary,
    "",
  ].join("\n");
}

/**
 * Formats the Mac wake-window section of a schedule listing, rendering a
 * not-configured placeholder when no power schedule exists.
 */
export function formatPowerScheduleStatus(
  schedule: PowerScheduleStatus | null,
): string {
  const divider = "-".repeat(22);

  if (!schedule) {
    return [
      divider,
      "Mac Wake Window",
      divider,
      "  Status : not configured",
      "",
      "",
    ].join("\n");
  }

  const rows = [
    ["Status", schedule.enabled ? "configured" : "disabled"],
    ["Days", schedule.days || "unknown"],
    ["Wake", schedule.wakeTime || "unknown"],
    ["Sleep", schedule.sleepTime || "unknown"],
    ["Updated", schedule.updatedAt],
  ];

  if (schedule.warning) {
    rows.push(["Warning", schedule.warning]);
  }

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const body = rows
    .map(([label, value]) => `  ${label.padEnd(labelWidth)} : ${value}`)
    .join("\n");

  return [divider, "Mac Wake Window", divider, body, "", ""].join("\n");
}

/**
 * Formats a single connector schedule into a bordered block describing its
 * cron expression, launchd installation state, and any warning.
 */
export function formatScheduleStatus(
  schedule: ConnectorScheduleStatus,
): string {
  const launchdStatus =
    schedule.pausedAt !== undefined
      ? "paused"
      : schedule.launchAgentPath === undefined
        ? "not installed"
        : schedule.launchAgentLoaded
          ? "loaded"
          : schedule.launchAgentPlistExists
            ? "plist exists, not loaded"
            : "plist missing";
  const rows = [
    ["Schedule", schedule.description],
    ["Cron", schedule.expression],
    ["Launchd", launchdStatus],
    ["Updated", schedule.updatedAt],
  ];

  if (schedule.pausedAt) {
    rows.push(["Paused", schedule.pausedAt]);
  }

  if (schedule.launchAgentPath) {
    rows.push(["Plist", schedule.launchAgentPath]);
  }

  if (schedule.warning) {
    rows.push(["Warning", schedule.warning]);
  }

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const body = rows
    .map(([label, value]) => `  ${label.padEnd(labelWidth)} : ${value}`)
    .join("\n");
  const scheduleLabel = schedule.displayName ?? schedule.sourceInstanceId;
  const divider = "-".repeat(Math.max(18, scheduleLabel.length + 10));

  return [
    divider,
    `Source : ${scheduleLabel}`,
    ...(schedule.connectorId ? [`Connector : ${schedule.connectorId}`] : []),
    divider,
    body,
    "",
  ].join("\n");
}
