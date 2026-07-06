import type { OpenWikiRunResult } from "./types.js";

export function getRunExitCode(result: OpenWikiRunResult): 0 | 1 {
  return result.hadToolError ? 1 : 0;
}
