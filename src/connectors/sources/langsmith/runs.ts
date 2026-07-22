import type { Run } from "langsmith";
import type { SampleStats, Trace, TraceRun } from "./types.js";

/**
 * Converts a trace's raw runs into an ordered, compacted tree, or undefined when
 * the trace is empty. Runs are ordered root-first then by start time so the tool
 * sequence is legible. Inputs/outputs are the PII surface and are included only
 * when includePayloads is true.
 */
export function compactTrace(
  runs: Run[],
  projectUrl: string,
  maxFieldChars: number,
  includePayloads: boolean,
): Trace | undefined {
  if (runs.length === 0) {
    return undefined;
  }

  const ordered = [...runs].sort(byStartTime);
  const root = ordered.find((run) => run.parent_run_id == null) ?? ordered[0];

  return {
    traceId: root.trace_id ?? root.id,
    traceUrl: `${projectUrl}/r/${root.id}`,
    isError: isErrorRun(root),
    runs: ordered.map((run) =>
      compactTraceRun(run, maxFieldChars, includePayloads),
    ),
  };
}

/**
 * Light summary over the sampled trace roots. Sample stats over the pulled
 * traces, not population stats: doing the arithmetic here keeps the update
 * agent's job to interpretation.
 */
export function summarizeSample(roots: Run[]): SampleStats {
  const latencies = roots
    .map(latencyMs)
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => left - right);

  return {
    sampleSize: roots.length,
    errorCount: roots.filter(isErrorRun).length,
    medianLatencyMs: median(latencies),
    totalTokens: roots.reduce((sum, run) => sum + (run.total_tokens ?? 0), 0),
  };
}

/**
 * Compacts one run of a trace tree, keeping structure (type + parent) and, when
 * allowed, truncated payloads.
 */
function compactTraceRun(
  run: Run,
  maxFieldChars: number,
  includePayloads: boolean,
): TraceRun {
  return {
    id: run.id,
    parentRunId: run.parent_run_id ?? undefined,
    runType: run.run_type,
    name: run.name,
    status: run.status,
    startTime: toIso(run.start_time),
    endTime: toIso(run.end_time),
    latencyMs: latencyMs(run),
    totalTokens: run.total_tokens,
    error: truncateField(run.error, maxFieldChars),
    inputs: includePayloads
      ? truncateField(run.inputs, maxFieldChars)
      : undefined,
    outputs: includePayloads
      ? truncateField(run.outputs, maxFieldChars)
      : undefined,
  };
}

/**
 * A run counts as failed when it errored or ended in the error status.
 */
function isErrorRun(run: Run): boolean {
  return run.status === "error" || run.error != null;
}

/**
 * Orders runs by start time, undefined last, for a legible tree.
 */
function byStartTime(left: Run, right: Run): number {
  const a = toDate(left.start_time)?.getTime() ?? Number.POSITIVE_INFINITY;
  const b = toDate(right.start_time)?.getTime() ?? Number.POSITIVE_INFINITY;
  return a - b;
}

/**
 * Median of a pre-sorted list, or null when empty.
 */
function median(sorted: number[]): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
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
 * Coerces the SDK's number|string timestamp to a Date, or undefined.
 */
function toDate(value: number | string | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Normalizes a run timestamp to an ISO string for output.
 */
function toIso(value: number | string | undefined): string | undefined {
  return toDate(value)?.toISOString();
}

/**
 * Stringifies a free-text field and truncates it with an explicit marker.
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
