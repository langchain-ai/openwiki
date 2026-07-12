import type { CliCommand } from "../../commands.js";
import { getErrorMessage } from "../../diagnostics.js";
import {
  readOpenWikiOnboardingConfig,
  saveOpenWikiOnboardingConfig,
} from "../../onboarding.js";
import {
  deleteConnectorSchedules,
  getSavedPowerScheduleStatus,
  listConnectorSchedules,
  pauseConnectorSchedules,
  resumeConnectorSchedules,
  type ConnectorScheduleStatus,
  type PowerScheduleStatus,
  type ScheduleMutationResult,
} from "../../schedules.js";

/**
 * Runs the `openwiki cron` command: lists connector schedules, or applies a
 * pause/resume/delete to a target and prints the updated schedule table. Sets
 * the process exit code.
 */
export async function runCronCommand(
  command: Extract<CliCommand, { kind: "cron" }>,
): Promise<void> {
  try {
    const config = await readOpenWikiOnboardingConfig();

    if (command.action !== "list") {
      if (!command.target) {
        throw new Error(`Target is required for cron ${command.action}.`);
      }

      const result =
        command.action === "pause"
          ? await pauseConnectorSchedules(config, command.target)
          : command.action === "resume"
            ? await resumeConnectorSchedules({
                config,
                cwd: process.cwd(),
                target: command.target,
              })
            : await deleteConnectorSchedules(config, command.target);

      await saveOpenWikiOnboardingConfig(result.config);
      process.stdout.write(
        formatScheduleMutationResult(command.action, result),
      );
      await printCronSchedules(result.config);
      process.exitCode = 0;
      return;
    }

    await printCronSchedules(config);
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

async function printCronSchedules(
  config: Awaited<ReturnType<typeof readOpenWikiOnboardingConfig>>,
): Promise<void> {
  const schedules = await listConnectorSchedules(config);
  const powerSchedule = getSavedPowerScheduleStatus(config);

  process.stdout.write(formatScheduleHeader(schedules.length));
  process.stdout.write(formatPowerScheduleStatus(powerSchedule));

  if (schedules.length === 0) {
    process.stdout.write("No connector schedules are configured.\n");
    return;
  }

  for (const schedule of schedules) {
    process.stdout.write(formatScheduleStatus(schedule));
  }
}

function formatScheduleMutationResult(
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

function formatScheduleHeader(scheduleCount: number): string {
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

function formatPowerScheduleStatus(
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

function formatScheduleStatus(schedule: ConnectorScheduleStatus): string {
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
