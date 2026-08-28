import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createEmptyOnboardingConfig } from "../../src/setup/onboarding.ts";
import type { OpenWikiOnboardingConfig } from "../../src/setup/onboarding.ts";

// This file drives the Windows native surface of schedules.ts: the
// schtasks shell-outs and the cron→trigger translator and cmd shim builder
// that are only reachable through them. The child_process and os mocks are
// deliberately kept in their own file so they never leak into the
// pure-surface suites (mirrors schedules-launchd.test.ts).

const HOME = vi.hoisted(() => {
  const base = (process.env.TEMP ?? process.env.TMPDIR ?? "/tmp").replace(
    /[\\/]+$/u,
    "",
  );
  return `${base}\\openwiki-schtasks-home-${process.pid}-${Date.now()}`;
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const patched = { ...actual, homedir: () => HOME };
  return { ...patched, default: patched };
});

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import {
  deleteConnectorSchedules,
  installConnectorSchedule,
  listConnectorSchedules,
  parseSchtasksTriggerArgs,
  pauseConnectorSchedules,
} from "../../src/scheduling/schedules.ts";

const SHIM_PATH = path.join(HOME, ".openwiki", "ingestion.schedule.cmd");
const TASK_NAME = "OpenWiki Ingestion";

const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_CONFIG_DIR = process.env.OPENWIKI_CONFIG_DIR;

type ExecOutcome = { error?: Error };

let execFileOutcome: (command: string, args: string[]) => ExecOutcome;

/** Forces the module's `process.platform` reads down the win32 branch. */
function stubWin32(): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: "win32",
  });
}

beforeEach(() => {
  stubWin32();
  execFileOutcome = () => ({});
  execFileMock.mockImplementation((...callArgs: unknown[]) => {
    const done = callArgs.at(-1) as (
      error: Error | null,
      stdout: unknown,
      stderr: string,
    ) => void;
    const command = callArgs[0] as string;
    const args = (callArgs[1] as string[]) ?? [];
    const { error } = execFileOutcome(command, args);
    done(error ?? null, { stdout: "", stderr: "" }, "");
  });
});

afterEach(() => {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: ORIGINAL_PLATFORM,
  });
  execFileMock.mockReset();
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.OPENWIKI_CONFIG_DIR;
  else process.env.OPENWIKI_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
});

afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(HOME, { force: true, recursive: true });
});

/** Builds an onboarding config carrying a single ingestion schedule. */
function configWithSchedule(
  expression: string,
  overrides: Partial<
    NonNullable<OpenWikiOnboardingConfig["ingestionSchedule"]>
  > = {},
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

describe("parseSchtasksTriggerArgs (pure cron→schtasks translation)", () => {
  test("translates a daily time", () => {
    expect(parseSchtasksTriggerArgs("30 2 * * *")).toEqual([
      "/SC",
      "DAILY",
      "/ST",
      "02:30",
    ]);
  });

  test("zero-pads single-digit hour and minute", () => {
    expect(parseSchtasksTriggerArgs("5 7 * * *")).toEqual([
      "/SC",
      "DAILY",
      "/ST",
      "07:05",
    ]);
  });

  test("translates a single weekday", () => {
    expect(parseSchtasksTriggerArgs("0 9 * * 1")).toEqual([
      "/SC",
      "WEEKLY",
      "/D",
      "MON",
      "/ST",
      "09:00",
    ]);
  });

  test("maps cron weekday 7 to Sunday", () => {
    expect(parseSchtasksTriggerArgs("0 9 * * 7")).toEqual([
      "/SC",
      "WEEKLY",
      "/D",
      "SUN",
      "/ST",
      "09:00",
    ]);
  });

  test("translates a day of month", () => {
    expect(parseSchtasksTriggerArgs("0 6 1 * *")).toEqual([
      "/SC",
      "MONTHLY",
      "/D",
      "1",
      "/ST",
      "06:00",
    ]);
  });

  test("rejects ranges, steps, and lists in any field", () => {
    expect(parseSchtasksTriggerArgs("*/15 2 * * *")).toBeNull();
    expect(parseSchtasksTriggerArgs("0 2-4 * * *")).toBeNull();
    expect(parseSchtasksTriggerArgs("0 2,4 * * *")).toBeNull();
    expect(parseSchtasksTriggerArgs("0 2 * * 1-5")).toBeNull();
  });

  test("rejects day-of-month and weekday restricted together", () => {
    // Cron ORs these fields; schtasks ANDs them. The near-dead trigger must
    // fall back to the saved-only warning instead of installing.
    expect(parseSchtasksTriggerArgs("0 2 1 * 1")).toBeNull();
  });

  test("rejects month-pinned expressions", () => {
    expect(parseSchtasksTriggerArgs("0 2 * 3 *")).toBeNull();
  });

  test("rejects out-of-range and non-numeric field values", () => {
    expect(parseSchtasksTriggerArgs("60 2 * * *")).toBeNull();
    expect(parseSchtasksTriggerArgs("0 24 * * *")).toBeNull();
    expect(parseSchtasksTriggerArgs("0 2 32 * *")).toBeNull();
    expect(parseSchtasksTriggerArgs("0 2 * * 8")).toBeNull();
    expect(parseSchtasksTriggerArgs("0 2 * * SUN")).toBeNull();
  });

  test("rejects malformed expressions", () => {
    expect(parseSchtasksTriggerArgs("0 2 * *")).toBeNull();
    expect(parseSchtasksTriggerArgs("0 2 * * * extra")).toBeNull();
    expect(parseSchtasksTriggerArgs("")).toBeNull();
  });
});

describe("installConnectorSchedule (win32 native install)", () => {
  test("writes a shim and creates the task with an explicit argv", async () => {
    const result = await installConnectorSchedule({
      connectorId: "git-repo",
      cronExpression: "0 2 * * *",
      cwd: "C:\\repo",
    });

    expect(result.nativeJobPath).toBe(SHIM_PATH);
    expect(result.warning).toBeUndefined();

    const { readFile } = await import("node:fs/promises");
    const shim = await readFile(SHIM_PATH, "utf8");
    // The shim cds to the wiki repo, runs the CLI in scheduled mode, and
    // appends both streams to the ingestion log.
    expect(shim).toContain(`cd /d "C:\\repo"`);
    expect(shim).toContain("ingest all --scheduled --print");
    expect(shim).toContain("ingestion.schedule.log");
    expect(shim).not.toContain("OPENWIKI_CONFIG_DIR");

    const create = execFileMock.mock.calls.find(
      ([command]) => command === "schtasks",
    );
    expect(create?.[1]).toEqual([
      "/Create",
      "/F",
      "/SC",
      "DAILY",
      "/ST",
      "02:00",
      "/TN",
      TASK_NAME,
      "/TR",
      SHIM_PATH,
    ]);
    // No shell option: schtasks must be spawned directly with an argv array.
    const options = create
      ?.slice(2)
      .find(
        (arg): arg is Record<string, unknown> =>
          typeof arg === "object" && arg !== null,
      );
    expect(options?.shell ?? false).toBe(false);
  });

  test("passes the resolved config dir into the shim environment", async () => {
    const configuredDir = "C:\\openwiki state";
    process.env.OPENWIKI_CONFIG_DIR = configuredDir;

    await installConnectorSchedule({
      connectorId: "git-repo",
      cronExpression: "0 2 * * *",
      cwd: "C:\\repo",
    });

    const { readFile } = await import("node:fs/promises");
    const shim = await readFile(SHIM_PATH, "utf8");
    expect(shim).toContain(`set "OPENWIKI_CONFIG_DIR=${configuredDir}"`);
  });

  test("degrades to a saved-only warning when schtasks fails", async () => {
    const { access, mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.dirname(SHIM_PATH), { recursive: true });
    await writeFile(SHIM_PATH, "@echo off\r\n", "utf8");
    execFileOutcome = (command, args) =>
      command === "schtasks" && args[0] === "/Create"
        ? { error: new Error("access denied") }
        : {};

    const result = await installConnectorSchedule({
      connectorId: "git-repo",
      cronExpression: "0 2 * * *",
      cwd: "C:\\repo",
    });

    expect(result.nativeJobPath).toBeUndefined();
    expect(result.warning).toMatch(/installing the Windows scheduled task failed/i);
    const remove = execFileMock.mock.calls.find(
      ([command, args]) => command === "schtasks" && args[0] === "/Delete",
    );
    expect(remove?.[1]).toEqual(["/Delete", "/F", "/TN", TASK_NAME]);
    await expect(access(SHIM_PATH)).rejects.toThrow();
  });

  test("removes the old task before saving an expression too complex for schtasks", async () => {
    const { access, mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.dirname(SHIM_PATH), { recursive: true });
    await writeFile(SHIM_PATH, "@echo off\r\n", "utf8");

    const result = await installConnectorSchedule({
      connectorId: "git-repo",
      cronExpression: "*/15 2 * * *",
      cwd: "C:\\repo",
    });

    expect(result.nativeJobPath).toBeUndefined();
    expect(result.warning).toMatch(/too complex/i);
    const remove = execFileMock.mock.calls.find(
      ([command, args]) => command === "schtasks" && args[0] === "/Delete",
    );
    expect(remove?.[1]).toEqual(["/Delete", "/F", "/TN", TASK_NAME]);
    await expect(access(SHIM_PATH)).rejects.toThrow();
  });
});

describe("listConnectorSchedules (win32 status)", () => {
  test("reports the task as installed when schtasks /Query succeeds", async () => {
    const [status] = await listConnectorSchedules(
      configWithSchedule("0 2 * * *", { nativeJobPath: SHIM_PATH }),
    );

    expect(status.nativeJobInstalled).toBe(true);
    const query = execFileMock.mock.calls.find(
      ([command, args]) =>
        command === "schtasks" && (args as string[])[0] === "/Query",
    );
    expect(query?.[1]).toEqual(["/Query", "/TN", TASK_NAME]);
  });

  test("reports the task as not installed when schtasks /Query fails", async () => {
    execFileOutcome = (command, args) =>
      command === "schtasks" && args[0] === "/Query"
        ? { error: new Error("The system cannot find the file specified") }
        : {};

    const [status] = await listConnectorSchedules(
      configWithSchedule("0 2 * * *", { nativeJobPath: SHIM_PATH }),
    );

    expect(status.nativeJobInstalled).toBe(false);
  });
});

describe("pause/delete (win32 cleanup)", () => {
  test("pause deletes the task and reports no warnings", async () => {
    const { access, mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.dirname(SHIM_PATH), { recursive: true });
    await writeFile(SHIM_PATH, "@echo off\r\n", "utf8");

    const result = await pauseConnectorSchedules(
      configWithSchedule("0 2 * * *"),
      "all",
    );

    expect(result.connectorIds).toEqual(["all"]);
    expect(result.config.ingestionSchedule?.pausedAt).toBeDefined();
    const remove = execFileMock.mock.calls.find(
      ([command, args]) =>
        command === "schtasks" && (args as string[])[0] === "/Delete",
    );
    expect(remove?.[1]).toEqual(["/Delete", "/F", "/TN", TASK_NAME]);
    await expect(access(SHIM_PATH)).resolves.toBeUndefined();
  });

  test("delete removes the task and the shim file", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(SHIM_PATH), { recursive: true });
    await writeFile(SHIM_PATH, "@echo off\r\n", "utf8");

    const result = await deleteConnectorSchedules(
      configWithSchedule("0 2 * * *", { nativeJobPath: SHIM_PATH }),
      "all",
    );

    expect(result.connectorIds).toEqual(["all"]);
    const { access } = await import("node:fs/promises");
    await expect(access(SHIM_PATH)).rejects.toThrow();
    const remove = execFileMock.mock.calls.find(
      ([command, args]) =>
        command === "schtasks" && (args as string[])[0] === "/Delete",
    );
    expect(remove?.[1]).toEqual(["/Delete", "/F", "/TN", TASK_NAME]);
  });

  test("delete survives a missing shim file", async () => {
    const result = await deleteConnectorSchedules(
      configWithSchedule("0 2 * * *"),
      "all",
    );

    expect(result.connectorIds).toEqual(["all"]);
    expect(result.warnings).toEqual([]);
  });
});
