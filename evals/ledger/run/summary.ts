import type { LedgerRunResult } from "../core/types.js";
import { formatPercent, formatTokenCount } from "./format.js";
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
  const tokenCounts = result.checkpoints.map(
    (checkpoint) => checkpoint.efficiency.totalTokens,
  );
  const totalTokens =
    tokenCounts.length > 0 &&
    tokenCounts.every((tokens): tokens is number => tokens !== undefined)
      ? tokenCounts.reduce((sum, tokens) => sum + tokens, 0)
      : undefined;
  const tokens =
    totalTokens === undefined
      ? ""
      : ` · ${formatTokenCount(totalTokens)} OpenWiki tokens`;
  lines.push(
    `└ ${incomplete ? "⚠️" : "✅"} LEDGER score ${formatPercent(result.score.value, 0)}${elapsed}${tokens}`,
  );
  return `${lines.join("\n")}\n\n`;
}
