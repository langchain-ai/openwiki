import type { OpenWikiOutputMode } from "../agent/types.js";
import type { CliCommand, OpenWikiRunMode } from "../commands.js";
import { openWikiLocalWikiDir } from "../openwiki-home.js";

/**
 * Resolves the working directory for a run mode: the repository cwd for `code`,
 * the local wiki directory for `personal`.
 */
export function getRunModeCwd(
  mode: OpenWikiRunMode,
  codeRuntimeCwd = process.cwd(),
): string {
  return mode === "code" ? codeRuntimeCwd : openWikiLocalWikiDir;
}

/**
 * Maps a run mode to its output mode (`code` -> `repository`, `personal` ->
 * `local-wiki`).
 */
export function getRunModeOutputMode(
  mode: OpenWikiRunMode,
): OpenWikiOutputMode {
  return mode === "code" ? "repository" : "local-wiki";
}

/**
 * True when a startup run should auto-exit on success: a non-dry, non-print
 * `init` or `update` that is set to start.
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
