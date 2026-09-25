import type { Run } from "langsmith";
import type { SampleStats, Trace, TraceBucket, TraceRun } from "./types.js";

/**
 * One selected root run and the bucket that put it in the sample.
 */
export interface BucketedRoot {
  bucket: TraceBucket;
  run: Run;
}

/**
 * Caps for anomaly-weighted selection. `total` is the overall trace budget.
 */
export interface SampleCaps {
  errorCap: number;
  outlierCap: number;
  total: number;
}

/**
 * Selects the sample from two lean root-run pools within the window, biased
 * toward anomalies: errors first (up to errorCap), then latency outliers among
 * the non-errored runs (up to outlierCap, at most a quarter of the non-errored
 * pool so the bucket stays a genuine tail rather than swallowing a small pull,
 * and the remaining budget), then the most-recent non-errored runs to backfill
 * to `total`. With no errors/outliers it degrades to all-baseline — the same
 * recency behavior as before. Runs are deduped by id; `nonErrorRuns` is assumed
 * most-recent-first.
 */
export function selectSampleBuckets(
  errorRuns: Run[],
  nonErrorRuns: Run[],
  caps: SampleCaps,
): BucketedRoot[] {
  const selected: BucketedRoot[] = [];
  const usedIds = new Set<string>();

  const take = (run: Run, bucket: TraceBucket): void => {
    if (selected.length >= caps.total || usedIds.has(run.id)) {
      return;
    }
    usedIds.add(run.id);
    selected.push({ bucket, run });
  };

  for (const run of errorRuns.slice(0, caps.errorCap)) {
    take(run, "error");
  }

  // Keep outliers a genuine tail: never more than the flat cap, the remaining
  // budget, or a quarter of the non-errored pool (so a small pull stays mostly
  // baseline instead of being relabeled as outliers).
  const outlierBudget = Math.min(
    caps.outlierCap,
    caps.total - selected.length,
    Math.floor(nonErrorRuns.length / 4),
  );
  const byLatencyDesc = nonErrorRuns
    .filter((run) => !usedIds.has(run.id))
    .map((run) => ({ latency: latencyMs(run) ?? -1, run }))
    .sort((left, right) => right.latency - left.latency)
    .slice(0, outlierBudget);
  for (const { run } of byLatencyDesc) {
    take(run, "outlier");
  }

  for (const run of nonErrorRuns) {
    take(run, "baseline");
  }

  return selected;
}

/**
 * Converts a trace's raw runs into an ordered, compacted tree tagged with its
 * sampling bucket, or undefined when the trace is empty. Runs are ordered
 * root-first then by start time so the tool sequence is legible. Inputs/outputs
 * are never fetched (they are enormous for coding-agent traces and never reach
 * the committed page), so a compacted run is structure, timings, tokens, and the
 * truncated error text.
 */
export function compactTrace(
  runs: Run[],
  projectUrl: string,
  bucket: TraceBucket,
  maxFieldChars: number,
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
    bucket,
    runs: ordered.map((run) => compactTraceRun(run, maxFieldChars)),
  };
}

/**
 * Light summary over the selected roots. Because the sample is anomaly-weighted,
 * bucket counts are reported as composition and medians are computed over the
 * BASELINE bucket only, so they read as normal-operation references rather than
 * fleet rates skewed by the over-sampled tail.
 */
export function summarizeSample(selected: BucketedRoot[]): SampleStats {
  const bucketCounts: Record<TraceBucket, number> = {
    baseline: 0,
    error: 0,
    outlier: 0,
  };
  const baselineLatencies: number[] = [];
  const baselineTokens: number[] = [];

  for (const { bucket, run } of selected) {
    bucketCounts[bucket] += 1;
    if (bucket !== "baseline") {
      continue;
    }
    const latency = latencyMs(run);
    if (latency !== undefined) {
      baselineLatencies.push(latency);
    }
    if (typeof run.total_tokens === "number") {
      baselineTokens.push(run.total_tokens);
    }
  }

  baselineLatencies.sort((left, right) => left - right);
  baselineTokens.sort((left, right) => left - right);

  return {
    sampleSize: selected.length,
    bucketCounts,
    baselineMedianLatencyMs: median(baselineLatencies),
    baselineMedianTokens: median(baselineTokens),
  };
}

/**
 * Compacts one run of a trace tree, keeping structure (type + parent), timings,
 * tokens, and the truncated error text.
 */
function compactTraceRun(run: Run, maxFieldChars: number): TraceRun {
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
  };
}

/**
 * A run counts as failed when it errored or ended in the error status. An
 * "interrupted" run is NOT a failure: that status marks a human-in-the-loop
 * pause (a GraphInterrupt awaiting approval), which is normal control flow, and
 * its error field carries the paused action's args, not a failure signature —
 * so counting it would both mislabel the sample and drag user data into the
 * committed error text.
 */
export function isErrorRun(run: Run): boolean {
  if (run.status === "interrupted") {
    return false;
  }
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
