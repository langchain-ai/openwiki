import { execFile } from "node:child_process";
import { access, chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CronExpressionParser } from "cron-parser";
import cronstrue from "cronstrue";
import { ensureOpenWikiHome, openWikiHomeDir } from "./openwiki-home.js";
import type { ConnectorId } from "./connectors/types.js";
import type { OpenWikiOnboardingConfig } from "./onboarding.js";

const execFileAsync = promisify(execFile);
const DEFAULT_FIRST_HOUR = 2;

export type CronValidationResult =
  | {
      description: string;
      expression: string;
      valid: true;
    }
  | {
      error: string;
      expression: string;
      valid: false;
    };

export type ScheduleInstallResult = {
  description: string;
  expression: string;
  launchAgentPath?: string;
  warning?: string;
};

export type ConnectorScheduleStatus = {
  connectorId?: ConnectorId;
  description: string;
  displayName?: string;
  expression: string;
  launchAgentLoaded: boolean;
  launchAgentPath?: string;
  launchAgentPlistExists: boolean;
  pausedAt?: string;
  sourceInstanceId: string;
  updatedAt: string;
  warning?: string;
};

export type PowerScheduleInstallResult = {
  days: string;
  enabled: boolean;
  sleepTime: string;
  wakeTime: string;
  warning?: string;
};

export type PowerScheduleStatus = PowerScheduleInstallResult & {
  updatedAt: string;
};

export type ScheduleMutationResult = {
  config: OpenWikiOnboardingConfig;
  connectorIds: string[];
  powerSchedule?: PowerScheduleInstallResult;
  skippedConnectorIds: string[];
  warnings: string[];
};

export type ScheduleTarget = ConnectorId | "all";

type CalendarInterval = Partial<
  Record<"Hour" | "Minute" | "Month" | "Day" | "Weekday", number>
>;

type RepeatScheduleTime = {
  days: string;
  minuteOfDay: number;
};

const PMSET_WAKE_OFFSET_MINUTES = 2;
const PMSET_SLEEP_OFFSET_MINUTES = 30;
const PMSET_DEFAULT_DAYS = "MTWRFSU";

export function validateCronExpression(
  expression: string,
): CronValidationResult {
  const normalizedExpression = normalizeCronExpression(expression);

  if (!normalizedExpression) {
    return {
      error: "Enter a cron expression like 0 2 * * *.",
      expression: normalizedExpression,
      valid: false,
    };
  }

  try {
    CronExpressionParser.parse(normalizedExpression);
    return {
      description: describeCronExpression(normalizedExpression),
      expression: normalizedExpression,
      valid: true,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Invalid cron schedule.",
      expression: normalizedExpression,
      valid: false,
    };
  }
}

export function describeCronExpression(expression: string): string {
  return cronstrue.toString(expression, {
    throwExceptionOnParseError: true,
    use24HourTimeFormat: false,
  });
}

export function getSuggestedCronExpression(
  config: OpenWikiOnboardingConfig,
): string {
  return (
    config.ingestionSchedule?.expression ?? `0 ${DEFAULT_FIRST_HOUR} * * *`
  );
}

export async function installConnectorSchedule({
  connectorId,
  cronExpression,
  cwd,
}: {
  connectorId: ConnectorId;
  cronExpression: string;
  cwd: string;
}): Promise<ScheduleInstallResult> {
  const validation = validateCronExpression(cronExpression);

  if (!validation.valid) {
    throw new Error(validation.error);
  }

  if (process.platform !== "darwin") {
    return {
      description: validation.description,
      expression: validation.expression,
      warning:
        "Schedule saved, but native installation is currently macOS-only.",
    };
  }

  const calendarInterval = parseLaunchdCalendarInterval(validation.expression);
  if (!calendarInterval) {
    return {
      description: validation.description,
      expression: validation.expression,
      warning:
        "Schedule saved, but this cron expression is too complex for direct launchd installation.",
    };
  }

  void connectorId;
  const label = getLaunchAgentLabel();
  const launchAgentsDir = getLaunchAgentsDir();
  const logsDir = path.join(openWikiHomeDir, "logs");
  const plistPath = getLaunchAgentPath();

  await ensureOpenWikiHome();
  await mkdir(launchAgentsDir, { recursive: true, mode: 0o700 });
  await mkdir(logsDir, { recursive: true, mode: 0o700 });
  await writeFile(
    plistPath,
    createLaunchAgentPlist({
      calendarInterval,
      cwd,
      label,
      logPath: path.join(logsDir, "ingestion.schedule.log"),
    }),
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  await chmod(plistPath, 0o600);

  await unloadLaunchAgent();
  const launchdDomain = getLaunchdDomain();
  await execFileAsync("launchctl", ["bootstrap", launchdDomain, plistPath]);

  return {
    description: validation.description,
    expression: validation.expression,
    launchAgentPath: plistPath,
  };
}

export async function listConnectorSchedules(
  config: OpenWikiOnboardingConfig,
): Promise<ConnectorScheduleStatus[]> {
  const schedule = config.ingestionSchedule;
  if (!schedule) {
    return [];
  }

  const launchAgentPath = schedule.launchAgentPath;
  return [
    {
      description: schedule.description,
      displayName: "All ingestion",
      expression: schedule.expression,
      launchAgentLoaded: schedule.pausedAt
        ? false
        : await isLaunchAgentLoaded(),
      launchAgentPath,
      launchAgentPlistExists: launchAgentPath
        ? await pathExists(launchAgentPath)
        : false,
      pausedAt: schedule.pausedAt,
      sourceInstanceId: "all",
      updatedAt: schedule.updatedAt,
      warning: schedule.warning,
    },
  ];
}

export async function pauseConnectorSchedules(
  config: OpenWikiOnboardingConfig,
  target: ScheduleTarget,
): Promise<ScheduleMutationResult> {
  if (
    target !== "all" ||
    !config.ingestionSchedule ||
    config.ingestionSchedule.pausedAt
  ) {
    return {
      config,
      connectorIds: [],
      skippedConnectorIds: [target],
      warnings: [],
    };
  }

  let nextConfig = cloneOnboardingConfig(config);
  nextConfig = {
    ...nextConfig,
    ingestionSchedule: {
      ...config.ingestionSchedule,
      pausedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
  await unloadLaunchAgent();

  const reconciled = await reconcileOpenWikiPowerSchedule(nextConfig);
  return {
    config: reconciled.config,
    connectorIds: ["all"],
    powerSchedule: reconciled.powerSchedule,
    skippedConnectorIds: [],
    warnings: reconciled.powerSchedule?.warning
      ? [reconciled.powerSchedule.warning]
      : [],
  };
}

export async function resumeConnectorSchedules({
  config,
  cwd,
  target,
}: {
  config: OpenWikiOnboardingConfig;
  cwd: string;
  target: ScheduleTarget;
}): Promise<ScheduleMutationResult> {
  if (
    target !== "all" ||
    !config.ingestionSchedule ||
    !config.ingestionSchedule.pausedAt
  ) {
    return {
      config,
      connectorIds: [],
      skippedConnectorIds: [target],
      warnings: [],
    };
  }

  const result = await installConnectorSchedule({
    connectorId: "git-repo",
    cronExpression: config.ingestionSchedule.expression,
    cwd,
  });
  const nextConfig = {
    ...cloneOnboardingConfig(config),
    ingestionSchedule: {
      description: result.description,
      expression: result.expression,
      launchAgentPath: result.launchAgentPath,
      updatedAt: new Date().toISOString(),
      warning: result.warning,
    },
  };

  const reconciled = await reconcileOpenWikiPowerSchedule(nextConfig);
  return {
    config: reconciled.config,
    connectorIds: ["all"],
    powerSchedule: reconciled.powerSchedule,
    skippedConnectorIds: [],
    warnings: [
      ...(result.warning ? [result.warning] : []),
      ...(reconciled.powerSchedule?.warning
        ? [reconciled.powerSchedule.warning]
        : []),
    ],
  };
}

export async function deleteConnectorSchedules(
  config: OpenWikiOnboardingConfig,
  target: ScheduleTarget,
): Promise<ScheduleMutationResult> {
  if (target !== "all" || !config.ingestionSchedule) {
    return {
      config,
      connectorIds: [],
      skippedConnectorIds: [target],
      warnings: [],
    };
  }

  const nextConfig = cloneOnboardingConfig(config);
  delete nextConfig.ingestionSchedule;
  await unloadLaunchAgent();
  await removeLaunchAgentPlist();

  const reconciled = await reconcileOpenWikiPowerSchedule(nextConfig);
  return {
    config: reconciled.config,
    connectorIds: ["all"],
    powerSchedule: reconciled.powerSchedule,
    skippedConnectorIds: [],
    warnings: reconciled.powerSchedule?.warning
      ? [reconciled.powerSchedule.warning]
      : [],
  };
}

export async function installOpenWikiPowerSchedule(
  config: OpenWikiOnboardingConfig,
): Promise<PowerScheduleInstallResult> {
  const powerWindow = getPowerWindowForConfiguredSchedules(config);

  if (!powerWindow) {
    return {
      days: PMSET_DEFAULT_DAYS,
      enabled: false,
      sleepTime: "",
      wakeTime: "",
      warning:
        "Wake setup skipped because no saved schedules can be represented as a simple macOS repeat wake window.",
    };
  }

  if (process.platform !== "darwin") {
    return {
      ...powerWindow,
      enabled: false,
      warning: "Wake setup is currently macOS-only.",
    };
  }

  const pmsetArgs = [
    "repeat",
    "wakeorpoweron",
    powerWindow.days,
    powerWindow.wakeTime,
    "sleep",
    powerWindow.days,
    powerWindow.sleepTime,
  ];

  try {
    await execFileAsync("osascript", [
      "-e",
      `do shell script ${toAppleScriptString(
        pmsetCommand(pmsetArgs),
      )} with administrator privileges`,
    ]);

    return {
      ...powerWindow,
      enabled: true,
      warning:
        "macOS supports one repeat power schedule. OpenWiki updated it to cover the currently saved connector schedules.",
    };
  } catch (error) {
    return {
      ...powerWindow,
      enabled: false,
      warning: `Wake setup was not installed: ${getErrorMessage(error)}`,
    };
  }
}

export function getSavedPowerScheduleStatus(
  config: OpenWikiOnboardingConfig,
): PowerScheduleStatus | null {
  const savedPmset = config.powerManagement?.pmset;

  if (!savedPmset) {
    return null;
  }

  return {
    days: savedPmset.days,
    enabled: savedPmset.enabled,
    sleepTime: savedPmset.sleepTime,
    updatedAt: savedPmset.updatedAt,
    wakeTime: savedPmset.wakeTime,
    warning: savedPmset.warning,
  };
}

async function reconcileOpenWikiPowerSchedule(
  config: OpenWikiOnboardingConfig,
): Promise<{
  config: OpenWikiOnboardingConfig;
  powerSchedule?: PowerScheduleInstallResult;
}> {
  const savedPmset = config.powerManagement?.pmset;
  if (!savedPmset) {
    return { config };
  }

  if (!hasActiveIngestionSchedule(config)) {
    if (!savedPmset.enabled) {
      return { config };
    }

    const result = await cancelOpenWikiPowerSchedule();
    return {
      config: {
        ...config,
        powerManagement: {
          ...config.powerManagement,
          pmset: {
            days: savedPmset.days,
            enabled: false,
            sleepTime: savedPmset.sleepTime,
            updatedAt: new Date().toISOString(),
            wakeTime: savedPmset.wakeTime,
            warning: result.warning,
          },
        },
      },
      powerSchedule: result,
    };
  }

  const result = await installOpenWikiPowerSchedule(config);
  return {
    config: {
      ...config,
      powerManagement: {
        ...config.powerManagement,
        pmset: {
          days: result.days,
          enabled: result.enabled,
          sleepTime: result.sleepTime,
          updatedAt: new Date().toISOString(),
          wakeTime: result.wakeTime,
          warning: result.warning,
        },
      },
    },
    powerSchedule: result,
  };
}

async function cancelOpenWikiPowerSchedule(): Promise<PowerScheduleInstallResult> {
  const disabledSchedule = {
    days: "",
    enabled: false,
    sleepTime: "",
    wakeTime: "",
  };

  if (process.platform !== "darwin") {
    return {
      ...disabledSchedule,
      warning: "Wake setup is currently macOS-only.",
    };
  }

  try {
    await execFileAsync("osascript", [
      "-e",
      `do shell script ${toAppleScriptString(
        pmsetCommand(["repeat", "cancel"]),
      )} with administrator privileges`,
    ]);

    return {
      ...disabledSchedule,
      warning: "OpenWiki removed the macOS repeat wake/sleep schedule.",
    };
  } catch (error) {
    return {
      ...disabledSchedule,
      warning: `Wake setup was not removed: ${getErrorMessage(error)}`,
    };
  }
}

function hasActiveIngestionSchedule(config: OpenWikiOnboardingConfig): boolean {
  return Boolean(
    config.ingestionSchedule && !config.ingestionSchedule.pausedAt,
  );
}

function cloneOnboardingConfig(
  config: OpenWikiOnboardingConfig,
): OpenWikiOnboardingConfig {
  const sourceInstances = config.sourceInstances.map((sourceConfig) => ({
    ...sourceConfig,
    connectorConfig: sourceConfig.connectorConfig
      ? { ...sourceConfig.connectorConfig }
      : undefined,
  }));

  return {
    ...config,
    ingestionSchedule: config.ingestionSchedule
      ? { ...config.ingestionSchedule }
      : undefined,
    powerManagement: config.powerManagement
      ? {
          ...config.powerManagement,
          pmset: config.powerManagement.pmset
            ? { ...config.powerManagement.pmset }
            : undefined,
        }
      : undefined,
    sourceInstances,
    sources: deriveLegacySources(sourceInstances),
  };
}

function deriveLegacySources(
  sourceInstances: OpenWikiOnboardingConfig["sourceInstances"],
): OpenWikiOnboardingConfig["sources"] {
  const sources: OpenWikiOnboardingConfig["sources"] = {};

  for (const sourceConfig of sourceInstances) {
    if (!sources[sourceConfig.connectorId]) {
      sources[sourceConfig.connectorId] = {
        connectedAt: sourceConfig.connectedAt,
        connectorConfig: sourceConfig.connectorConfig,
        ingestionGoal: sourceConfig.ingestionGoal,
      };
    }
  }

  return sources;
}

function normalizeCronExpression(expression: string): string {
  return expression.trim().replace(/\s+/gu, " ");
}

function parseLaunchdCalendarInterval(
  expression: string,
): CalendarInterval | null {
  const parsed = parseSimpleCronFields(expression);
  if (!parsed) {
    return null;
  }

  const { day, hour, minute, month, weekday } = parsed;

  const parsedMinute = getSingleCronNumber(minute, { max: 59, min: 0 });
  if (parsedMinute === null) {
    return null;
  }

  const interval: CalendarInterval = {
    Minute: parsedMinute,
  };

  const parsedHour = getSingleCronNumber(hour, { max: 23, min: 0 });
  if (parsedHour !== null) {
    interval.Hour = parsedHour;
  } else if (hour !== "*") {
    return null;
  }

  const parsedDay = getSingleCronNumber(day, { max: 31, min: 1 });
  if (parsedDay !== null) {
    interval.Day = parsedDay;
  } else if (day !== "*") {
    return null;
  }

  const parsedMonth = getSingleCronNumber(month, { max: 12, min: 1 });
  if (parsedMonth !== null) {
    interval.Month = parsedMonth;
  } else if (month !== "*") {
    return null;
  }

  const parsedWeekday = getSingleCronNumber(weekday, { max: 7, min: 0 });
  if (parsedWeekday !== null) {
    interval.Weekday = parsedWeekday === 7 ? 0 : parsedWeekday;
  } else if (weekday !== "*") {
    return null;
  }

  return interval;
}

function parseSimpleCronFields(expression: string): {
  day: string;
  hour: string;
  minute: string;
  month: string;
  weekday: string;
} | null {
  const [minute, hour, day, month, weekday, ...extra] =
    expression.split(/\s+/u);
  if (!minute || !hour || !day || !month || !weekday || extra.length > 0) {
    return null;
  }

  return {
    day,
    hour,
    minute,
    month,
    weekday,
  };
}

function getPowerWindowForConfiguredSchedules(
  config: OpenWikiOnboardingConfig,
): Omit<PowerScheduleInstallResult, "enabled" | "warning"> | null {
  const parsedSchedules: RepeatScheduleTime[] = [];
  const schedule = config.ingestionSchedule;

  if (schedule && !schedule.pausedAt) {
    const parsedSchedule = parseRepeatScheduleTime(schedule.expression);
    if (parsedSchedule) {
      parsedSchedules.push(parsedSchedule);
    }
  }

  if (parsedSchedules.length === 0) {
    return null;
  }

  const days = mergePmsetDays(parsedSchedules.map((schedule) => schedule.days));
  const earliestMinute = Math.min(
    ...parsedSchedules.map((schedule) => schedule.minuteOfDay),
  );
  const latestMinute = Math.max(
    ...parsedSchedules.map((schedule) => schedule.minuteOfDay),
  );
  const wakeMinute = earliestMinute - PMSET_WAKE_OFFSET_MINUTES;
  const sleepMinute = latestMinute + PMSET_SLEEP_OFFSET_MINUTES;

  if (wakeMinute < 0 || sleepMinute >= 24 * 60) {
    return null;
  }

  return {
    days,
    sleepTime: formatPmsetTime(sleepMinute),
    wakeTime: formatPmsetTime(wakeMinute),
  };
}

function parseRepeatScheduleTime(
  expression: string,
): RepeatScheduleTime | null {
  const parsed = parseSimpleCronFields(expression);
  if (!parsed) {
    return null;
  }

  if (parsed.day !== "*" || parsed.month !== "*") {
    return null;
  }

  const minute = getSingleCronNumber(parsed.minute, { max: 59, min: 0 });
  const hour = getSingleCronNumber(parsed.hour, { max: 23, min: 0 });
  if (minute === null || hour === null) {
    return null;
  }

  const days = parsePmsetDays(parsed.weekday);
  if (!days) {
    return null;
  }

  return {
    days,
    minuteOfDay: hour * 60 + minute,
  };
}

function parsePmsetDays(weekday: string): string | null {
  if (weekday === "*") {
    return PMSET_DEFAULT_DAYS;
  }

  const parsedWeekday = getSingleCronNumber(weekday, { max: 7, min: 0 });
  if (parsedWeekday === null) {
    return null;
  }

  return weekdayNumberToPmsetDay(parsedWeekday);
}

function weekdayNumberToPmsetDay(weekday: number): string {
  switch (weekday === 7 ? 0 : weekday) {
    case 0:
      return "U";
    case 1:
      return "M";
    case 2:
      return "T";
    case 3:
      return "W";
    case 4:
      return "R";
    case 5:
      return "F";
    case 6:
      return "S";
    default:
      return "";
  }
}

function mergePmsetDays(days: string[]): string {
  const dayOrder = PMSET_DEFAULT_DAYS.split("");
  const usedDays = new Set(days.flatMap((daySet) => daySet.split("")));
  return dayOrder.filter((day) => usedDays.has(day)).join("");
}

function formatPmsetTime(minuteOfDay: number): string {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return `${hour.toString().padStart(2, "0")}:${minute
    .toString()
    .padStart(2, "0")}:00`;
}

function pmsetCommand(args: string[]): string {
  return ["pmset", ...args].map(toShellSingleQuotedArg).join(" ");
}

function toShellSingleQuotedArg(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function toAppleScriptString(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getSingleCronNumber(
  field: string | undefined,
  { max, min }: { max: number; min: number },
): number | null {
  if (!field || !/^\d+$/u.test(field)) {
    return null;
  }

  const value = Number(field);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function createLaunchAgentPlist({
  calendarInterval,
  cwd,
  label,
  logPath,
}: {
  calendarInterval: CalendarInterval;
  cwd: string;
  label: string;
  logPath: string;
}): string {
  const cliPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
  const programArguments = [
    process.execPath,
    cliPath,
    "ingest",
    "all",
    "--scheduled",
    "--print",
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapePlist(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map((arg) => `    <string>${escapePlist(arg)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapePlist(cwd)}</string>
  <key>StandardOutPath</key>
  <string>${escapePlist(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlist(logPath)}</string>
  <key>StartCalendarInterval</key>
  <dict>
${Object.entries(calendarInterval)
  .map(
    ([key, value]) => `    <key>${key}</key>
    <integer>${value}</integer>`,
  )
  .join("\n")}
  </dict>
</dict>
</plist>
`;
}

function getLaunchdDomain(): string {
  return `gui/${process.getuid?.() ?? os.userInfo().uid}`;
}

function getLaunchAgentLabel(): string {
  return "com.openwiki.ingestion";
}

function getLaunchAgentsDir(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents");
}

function getLaunchAgentPath(): string {
  return path.join(getLaunchAgentsDir(), `${getLaunchAgentLabel()}.plist`);
}

async function unloadLaunchAgent(): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }

  await execFileAsync("launchctl", [
    "bootout",
    `${getLaunchdDomain()}/${getLaunchAgentLabel()}`,
  ]).catch(() => null);
}

async function removeLaunchAgentPlist(): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }

  await unlink(getLaunchAgentPath()).catch((error: unknown) => {
    if (isFileNotFoundError(error)) {
      return;
    }

    throw error;
  });
}

async function isLaunchAgentLoaded(): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }

  try {
    await execFileAsync("launchctl", [
      "print",
      `${getLaunchdDomain()}/${getLaunchAgentLabel()}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function escapePlist(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}
