import { afterEach, describe, expect, test } from "vitest";
import {
  argvRequestsPrint,
  getRunModeCwd,
  getRunModeOutputMode,
  shouldAutoExitStartupRun,
  shouldPrintStartupError,
} from "../../src/cli/run-mode.ts";
import type { CliCommand } from "../../src/cli/commands.ts";
import { openWikiLocalWikiDir } from "../../src/config/openwiki-home.ts";

/**
 * Builds a `run` CliCommand with defaults for the fields under test.
 */
function runCommand(
  overrides: Partial<Extract<CliCommand, { kind: "run" }>> = {},
): CliCommand {
  return {
    kind: "run",
    command: "init",
    dryRun: false,
    exitCode: 0,
    language: null,
    mode: "local-wiki",
    modeSource: "default",
    modelId: null,
    print: false,
    shouldStart: true,
    telemetryFile: null,
    userMessage: null,
    ...overrides,
  };
}

/**
 * Builds an `error` CliCommand.
 */
function errorCommand(message = "bad args"): CliCommand {
  return { kind: "error", exitCode: 1, message };
}

describe("argvRequestsPrint", () => {
  test("detects -p and --print", () => {
    expect(argvRequestsPrint(["update", "-p"])).toBe(true);
    expect(argvRequestsPrint(["update", "--print"])).toBe(true);
  });

  test("returns false when neither flag is present", () => {
    expect(argvRequestsPrint(["update"])).toBe(false);
    expect(argvRequestsPrint([])).toBe(false);
  });
});

describe("shouldPrintStartupError", () => {
  const originalIsTTY = process.stdin.isTTY;

  afterEach(() => {
    process.stdin.isTTY = originalIsTTY;
  });

  test("is false for a non-error command", () => {
    process.stdin.isTTY = true;

    expect(shouldPrintStartupError(["-p"], runCommand(), runCommand())).toBe(
      false,
    );
  });

  test("prints an error when print mode is requested", () => {
    process.stdin.isTTY = true;

    expect(
      shouldPrintStartupError(["--print"], runCommand(), errorCommand()),
    ).toBe(true);
  });

  test("prints an error when there is no TTY", () => {
    process.stdin.isTTY = false;

    expect(shouldPrintStartupError([], runCommand(), errorCommand())).toBe(
      true,
    );
  });

  test("prints an error when a run was explicitly asked to start", () => {
    process.stdin.isTTY = true;

    expect(
      shouldPrintStartupError(
        [],
        runCommand({ shouldStart: true }),
        errorCommand(),
      ),
    ).toBe(true);
  });

  test("does not print when interactive and no run is starting", () => {
    process.stdin.isTTY = true;

    expect(
      shouldPrintStartupError(
        [],
        runCommand({ shouldStart: false }),
        errorCommand(),
      ),
    ).toBe(false);
  });
});

describe("getRunModeCwd", () => {
  test("uses the code runtime cwd in code mode", () => {
    expect(getRunModeCwd("code", "/work/repo")).toBe("/work/repo");
  });

  test("uses the local wiki dir for non-code modes", () => {
    expect(getRunModeCwd("local-wiki", "/work/repo")).toBe(
      openWikiLocalWikiDir,
    );
  });
});

describe("getRunModeOutputMode", () => {
  test("maps code to repository and everything else to local-wiki", () => {
    expect(getRunModeOutputMode("code")).toBe("repository");
    expect(getRunModeOutputMode("local-wiki")).toBe("local-wiki");
  });
});

describe("shouldAutoExitStartupRun", () => {
  test("auto-exits a real init/update run that was asked to start", () => {
    expect(shouldAutoExitStartupRun(runCommand({ command: "init" }))).toBe(
      true,
    );
    expect(shouldAutoExitStartupRun(runCommand({ command: "update" }))).toBe(
      true,
    );
  });

  test("does not auto-exit dry-run or print runs", () => {
    expect(shouldAutoExitStartupRun(runCommand({ dryRun: true }))).toBe(false);
    expect(shouldAutoExitStartupRun(runCommand({ print: true }))).toBe(false);
  });

  test("does not auto-exit when the run was not asked to start", () => {
    expect(shouldAutoExitStartupRun(runCommand({ shouldStart: false }))).toBe(
      false,
    );
  });

  test("does not auto-exit a non-run command", () => {
    expect(shouldAutoExitStartupRun(errorCommand())).toBe(false);
  });
});
