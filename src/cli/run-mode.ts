import type { OpenWikiOutputMode } from "../agent/types.js";
import { openWikiLocalWikiDir } from "../config/openwiki-home.js";
import type { CliCommand, OpenWikiRunMode } from "./commands.js";

/**
 * Reports whether the CLI args request non-interactive print mode (`-p` /
 * `--print`).
 */
export function argvRequestsPrint(argv: string[]): boolean {
  return argv.some((arg) => arg === "-p" || arg === "--print");
}

/**
 * Reports whether a startup parse error should be printed non-interactively
 * rather than surfaced in the interactive UI: when print mode is requested,
 * there is no TTY, or a run was explicitly asked to start.
 */
export function shouldPrintStartupError(
  argv: string[],
  parsedCommand: CliCommand,
  command: CliCommand,
): command is Extract<CliCommand, { kind: "error" }> {
  return (
    command.kind === "error" &&
    (argvRequestsPrint(argv) ||
      !process.stdin.isTTY ||
      (parsedCommand.kind === "run" && parsedCommand.shouldStart))
  );
}

/**
 * Resolves the working directory for a run: the code runtime's cwd in `code`
 * mode, otherwise the local wiki directory.
 *
 * @param codeRuntimeCwd Working directory used in `code` mode.
 *
 * @default codeRuntimeCwd process.cwd() - the current process working
 * directory.
 */
export function getRunModeCwd(
  mode: OpenWikiRunMode,
  codeRuntimeCwd = process.cwd(),
): string {
  return mode === "code" ? codeRuntimeCwd : openWikiLocalWikiDir;
}

/**
 * Maps a run mode to the output mode it writes: `repository` for `code`,
 * otherwise `local-wiki`.
 */
export function getRunModeOutputMode(
  mode: OpenWikiRunMode,
): OpenWikiOutputMode {
  return mode === "code" ? "repository" : "local-wiki";
}

/**
 * Reports whether a startup run should auto-exit when finished: a real
 * (non-dry-run, non-print) init or update run that was asked to start.
 */
export function shouldAutoExitStartupRun(command: CliCommand): boolean {
  return (
    command.kind === "run" &&
    !command.dryRun &&
    !command.print &&
    command.shouldStart &&
    (command.command === "init" || command.command === "update")
  );
}
