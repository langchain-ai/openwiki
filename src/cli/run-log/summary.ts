import type { OpenWikiCommand } from "../../agent/types.js";
import { formatCount } from "../format.js";
import type { RunLogItem, RunToolLogItem } from "./types.js";

/**
 * Categorized counters accumulated for one active run.
 */
interface RunCounts {
  /**
   * Total number of tool calls that started.
   */
  actionCount: number;

  /**
   * Number of tool calls that failed.
   *
   * @default undefined - no tool calls failed.
   */
  errorCount?: number;

  /**
   * Number of explicit file-read calls.
   */
  readCount: number;

  /**
   * Number of repository-search calls.
   */
  searchCount: number;

  /**
   * Number of delegated agent tasks.
   */
  taskCount: number;

  /**
   * Number of explicit file-write calls.
   */
  writeCount: number;
}

/**
 * Returns the single aggregate tool summary carried by a run log.
 */
export function findRunSummary(log: RunLogItem[]): RunToolLogItem | undefined {
  return log.find((item): item is RunToolLogItem => item.type === "tool");
}

/**
 * Formats the categorized progress counts shown while a run is active.
 */
export function formatRunCounts({
  actionCount,
  errorCount = 0,
  readCount,
  searchCount,
  taskCount,
  writeCount,
}: RunCounts): string {
  const parts: string[] = [];

  if (readCount > 0) {
    parts.push(formatCount(readCount, "read", "reads"));
  }

  if (searchCount > 0) {
    parts.push(formatCount(searchCount, "search", "searches"));
  }

  if (writeCount > 0) {
    parts.push(formatCount(writeCount, "write", "writes"));
  }

  if (taskCount > 0) {
    parts.push(formatCount(taskCount, "task", "tasks"));
  }

  if (parts.length === 0) {
    parts.push(formatCount(actionCount, "action", "actions"));
  }

  if (errorCount > 0) {
    parts.push(formatCount(errorCount, "failure", "failures"));
  }

  return parts.join(" · ");
}

/**
 * Formats the useful secondary counts for a completed run. Write-call counts
 * are omitted because the outcome title reports unique successfully written
 * pages instead.
 */
export function formatCompletedRunCounts(
  summary?: RunToolLogItem,
): string | undefined {
  if (!summary) {
    return undefined;
  }

  const parts = [
    summary.readCount
      ? formatCount(summary.readCount, "read", "reads")
      : undefined,
    summary.searchCount
      ? formatCount(summary.searchCount, "search", "searches")
      : undefined,
    summary.taskCount
      ? formatCount(summary.taskCount, "task", "tasks")
      : undefined,
    summary.errorCount
      ? formatCount(summary.errorCount, "failure", "failures")
      : undefined,
  ].filter((part): part is string => Boolean(part));

  if (parts.length === 0 && !summary.writeCount && summary.actionCount) {
    return formatCount(summary.actionCount, "action", "actions");
  }

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * Builds the outcome-first title for a settled run.
 */
export function formatRunCompletionTitle(
  command: OpenWikiCommand,
  log: RunLogItem[],
  durationMs?: number,
): string {
  if (durationMs === undefined) {
    return `Complete openwiki ${command}`;
  }

  const pageCount = findRunSummary(log)?.writtenPaths?.length ?? 0;
  const duration = formatRunDuration(durationMs);

  if (command === "update" && pageCount === 0) {
    return `OpenWiki is up to date in ${duration}`;
  }

  if (command === "update") {
    return `Updated ${formatCount(pageCount, "OpenWiki page", "OpenWiki pages")} in ${duration}`;
  }

  if (command === "init") {
    return `Generated ${formatCount(pageCount, "OpenWiki page", "OpenWiki pages")} in ${duration}`;
  }

  return `Completed openwiki ${command} in ${duration}`;
}

/**
 * Formats elapsed time compactly for terminal scrollback.
 */
function formatRunDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return "<1s";
  }

  const totalSeconds = Math.round(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return minutes === 0
    ? `${seconds}s`
    : seconds === 0
      ? `${minutes}m`
      : `${minutes}m ${seconds}s`;
}
