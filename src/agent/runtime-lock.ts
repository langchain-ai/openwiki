import type { ExecutionLockScope } from "../execution-lock.js";
import { openWikiLocalWikiDir } from "../openwiki-home.js";
import type { OpenWikiCommand, OpenWikiRunOptions } from "./types.js";

/**
 * Maps a user-facing agent invocation to its physical output scope before any
 * shared OpenWiki state is touched. Keeping this mapping separate makes the
 * locking boundary explicit and independently testable.
 */
export function getOpenWikiExecutionLockScope(
  command: OpenWikiCommand,
  cwd: string,
  options: Pick<OpenWikiRunOptions, "outputMode">,
): ExecutionLockScope {
  const outputMode = options.outputMode ?? "local-wiki";

  return {
    command,
    cwd: outputMode === "repository" ? cwd : openWikiLocalWikiDir,
    outputMode,
  };
}
