import type { LedgerRunResult } from "../core/types.js";
import { formatProgressDuration } from "./progress.js";

/** Optional paths and timing supplied by the CLI after persistence. */
export interface RunSummaryOptions {
  detailsPath?: string;
  elapsedMs?: number;
}

/** Render the deliberately small completion footer. Checkpoint claim state and
 * forgetting have already streamed above it, so the footer only links the audit
 * report and closes the frame. */
export function formatRunSummary(
  result: LedgerRunResult,
  options: RunSummaryOptions = {},
): string {
  const lines = ["│"];
  if (options.detailsPath !== undefined) {
    lines.push(`├ 🔬 Details → ${options.detailsPath}`);
  }
  const incomplete = result.checkpoints.some(
    (checkpoint) => checkpoint.evaluationCompleteness.rate < 1,
  );
  const elapsed =
    options.elapsedMs === undefined
      ? ""
      : ` · ${formatProgressDuration(options.elapsedMs)}`;
  lines.push(`└ ${incomplete ? "⚠️" : "✅"} Complete${elapsed}`);
  return `${lines.join("\n")}\n\n`;
}
