import type { Run } from "langsmith";

import type { CompactRun, ProjectStats } from "./types.js";

/**
 * Converts a raw API run into the truncated, citation-ready form written to
 * raw output. Free-text fields are capped at maxFieldChars because raw files
 * are read straight into the update agent's context.
 */
export function compactRun(
  run: Run,
  projectUrl: string,
  maxFieldChars: number,
): CompactRun {
  return {
    endTime: toIso(run.end_time),
    error: truncateField(run.error, maxFieldChars),
    id: run.id,
    inputs: truncateField(run.inputs, maxFieldChars),
    latencyMs: latencyMs(run),
    name: run.name,
    outputs: truncateField(run.outputs, maxFieldChars),
    startTime: toIso(run.start_time),
    status: run.status,
    totalTokens: run.total_tokens,
    traceUrl: `${projectUrl}/r/${run.id}`,
  };
}

/**
 * Computes per-project aggregates over the recent-runs sample. Both errorCount
 * and errorRate come from this single sample so the rate is internally
 * consistent — dividing a separately-capped error query by the recent count
 * would bias the rate. Doing the math here keeps the update agent's job to
 * interpretation, never arithmetic over raw trace data.
 */
export function computeStats(recentRuns: Run[]): ProjectStats {
  const errorCount = recentRuns.filter(isErrorRun).length;
  const latencies = recentRuns
    .map(latencyMs)
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => left - right);

  return {
    errorCount,
    errorRate:
      recentRuns.length > 0
        ? Math.round((errorCount / recentRuns.length) * 100) / 100
        : 0,
    latencyMsP50: percentile(latencies, 0.5),
    latencyMsP95: percentile(latencies, 0.95),
    runCount: recentRuns.length,
    totalTokens: recentRuns.reduce(
      (sum, run) => sum + (run.total_tokens ?? 0),
      0,
    ),
  };
}

/** A run counts as failed when it errored or ended in the error status. */
function isErrorRun(run: Run): boolean {
  return run.status === "error" || run.error != null;
}

/**
 * Returns the latest start_time among the given runs, used to advance the
 * per-project cursor so overlapping daily windows do not refetch runs.
 */
export function maxStartTime(runs: Run[]): string | undefined {
  return runs
    .map((run) => toIso(run.start_time))
    .filter((value): value is string => value !== undefined)
    .sort()
    .at(-1);
}

/**
 * Wall-clock duration of a run in milliseconds, when computable.
 */
function latencyMs(run: Run): number | undefined {
  const start = toDate(run.start_time);
  const end = toDate(run.end_time);
  if (!start || !end) {
    return undefined;
  }

  const ms = end.getTime() - start.getTime();
  return ms >= 0 ? ms : undefined;
}

/**
 * Coerces the SDK's `number | string` run timestamp to a Date, or undefined
 * when absent or unparseable. listRuns returns ISO strings in practice; the
 * numeric branch is treated as epoch milliseconds for completeness.
 */
function toDate(value: number | string | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Normalizes a run timestamp to an ISO string for output and cursor use. */
function toIso(value: number | string | undefined): string | undefined {
  return toDate(value)?.toISOString();
}

/**
 * Nearest-rank percentile over pre-sorted values. Returns null for an empty
 * list rather than guessing, so callers can render "no data" honestly.
 */
function percentile(sortedValues: number[], fraction: number): number | null {
  if (sortedValues.length === 0) {
    return null;
  }

  const index = Math.min(
    sortedValues.length - 1,
    Math.floor(fraction * sortedValues.length),
  );
  return sortedValues[index] ?? null;
}

/**
 * Stringifies a free-text field and truncates it with an explicit marker so
 * readers (human or agent) can tell truncation happened rather than assuming
 * the payload was short.
 */
function truncateField(value: unknown, maxChars: number): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}…[truncated]`
    : text;
}
