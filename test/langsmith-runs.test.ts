import { describe, expect, test } from "vitest";
import {
  compactTrace,
  isErrorRun,
  selectSampleBuckets,
  summarizeSample,
} from "../src/connectors/sources/langsmith/runs.ts";
import type { BucketedRoot } from "../src/connectors/sources/langsmith/runs.ts";
import type { Run } from "langsmith";

function run(fields: Record<string, unknown>): Run {
  return fields as unknown as Run;
}

const BASE = "2026-07-21T00:00:00.000Z";

/**
 * A root run with a known wall-clock latency (and optional token count).
 */
function root(id: string, latencyMs: number, tokens?: number): Run {
  return run({
    end_time: new Date(Date.parse(BASE) + latencyMs).toISOString(),
    id,
    start_time: BASE,
    ...(tokens === undefined ? {} : { total_tokens: tokens }),
  });
}

describe("compactTrace", () => {
  test("orders root-first then by start time and sets the trace fields", () => {
    const runs = [
      run({
        id: "child-b",
        name: "search",
        parent_run_id: "root",
        run_type: "tool",
        start_time: "2026-07-21T00:00:02.000Z",
      }),
      run({
        id: "root",
        parent_run_id: null,
        start_time: "2026-07-21T00:00:00.000Z",
        status: "success",
        trace_id: "trace-1",
      }),
      run({
        id: "child-a",
        parent_run_id: "root",
        run_type: "llm",
        start_time: "2026-07-21T00:00:01.000Z",
      }),
    ];

    const trace = compactTrace(runs, "https://smith/p", "baseline", 2000);

    expect(trace?.traceId).toBe("trace-1");
    expect(trace?.traceUrl).toBe("https://smith/p/r/root");
    expect(trace?.isError).toBe(false);
    expect(trace?.bucket).toBe("baseline");
    expect(trace?.runs.map((r) => r.id)).toEqual([
      "root",
      "child-a",
      "child-b",
    ]);
  });

  test("marks isError and carries the given bucket", () => {
    const trace = compactTrace(
      [
        run({
          id: "root",
          parent_run_id: null,
          status: "error",
          trace_id: "t",
        }),
      ],
      "https://smith/p",
      "error",
      2000,
    );

    expect(trace?.isError).toBe(true);
    expect(trace?.bucket).toBe("error");
  });

  test("keeps the truncated error text and never emits inputs/outputs", () => {
    const longError = "e".repeat(5000);
    const trace = compactTrace(
      [
        run({
          id: "root",
          error: longError,
          inputs: { q: "hi" },
          outputs: { a: "yo" },
          parent_run_id: null,
          status: "error",
          trace_id: "t",
        }),
      ],
      "https://smith/p",
      "error",
      100,
    );

    const compacted = trace?.runs[0];
    expect(compacted?.error).toContain("[truncated]");
    expect(compacted?.error?.length).toBeLessThan(longError.length);
    // Payloads are never fetched, so they never appear on a compacted run.
    expect(compacted).not.toHaveProperty("inputs");
    expect(compacted).not.toHaveProperty("outputs");
  });

  test("returns undefined for an empty trace", () => {
    expect(
      compactTrace([], "https://smith/p", "baseline", 2000),
    ).toBeUndefined();
  });
});

describe("isErrorRun", () => {
  test("counts error status and a populated error field as failures", () => {
    expect(isErrorRun(run({ id: "a", status: "error" }))).toBe(true);
    expect(isErrorRun(run({ id: "b", error: "CancelledError()" }))).toBe(true);
  });

  test("does NOT count an interrupted run (HITL GraphInterrupt) as a failure", () => {
    // A human-in-the-loop pause carries the paused action in its error field but
    // is control flow, not a failure.
    const interrupted = run({
      id: "c",
      status: "interrupted",
      error: "GraphInterrupt((Interrupt(value={'action_requests': [...]})))",
    });

    expect(isErrorRun(interrupted)).toBe(false);
  });

  test("a successful run is not a failure", () => {
    expect(isErrorRun(run({ id: "d", status: "success" }))).toBe(false);
  });
});

describe("selectSampleBuckets", () => {
  test("fills errors, then latency outliers, then baseline; deduped and capped", () => {
    const errorRuns = [root("e1", 10), root("e2", 10), root("e3", 10)];
    // most-recent-first order as the API returns them
    const nonErrorRuns = [
      root("n1", 100),
      root("n2", 900),
      root("n3", 200),
      root("n4", 50),
    ];

    const selected = selectSampleBuckets(errorRuns, nonErrorRuns, {
      errorCap: 2,
      outlierCap: 1,
      total: 4,
    });

    // 2 errors (cap), 1 outlier (n2, highest latency), 1 baseline (n1, most recent unused)
    expect(selected.map((s) => [s.run.id, s.bucket])).toEqual([
      ["e1", "error"],
      ["e2", "error"],
      ["n2", "outlier"],
      ["n1", "baseline"],
    ]);
  });

  test("degrades to all-baseline when there are no errors and no outlier budget", () => {
    const selected = selectSampleBuckets([], [root("n1", 1), root("n2", 2)], {
      errorCap: 5,
      outlierCap: 0,
      total: 5,
    });

    expect(selected.map((s) => s.bucket)).toEqual(["baseline", "baseline"]);
  });

  test("never exceeds the total cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => root(`n${i}`, i));

    const selected = selectSampleBuckets([], many, {
      errorCap: 0,
      outlierCap: 0,
      total: 3,
    });

    expect(selected).toHaveLength(3);
  });

  test("caps outliers at a quarter of the non-errored pool on a small sample", () => {
    // 8 non-error runs with a generous flat cap (5): the proportional cap
    // (floor(8/4)=2) wins, so only the 2 slowest are outliers and the rest stay
    // baseline instead of the bucket swallowing the small pull.
    const nonErrorRuns = Array.from({ length: 8 }, (_, i) =>
      root(`n${i}`, i * 10),
    );

    const selected = selectSampleBuckets([], nonErrorRuns, {
      errorCap: 10,
      outlierCap: 5,
      total: 20,
    });

    const outliers = selected.filter((s) => s.bucket === "outlier");
    const baseline = selected.filter((s) => s.bucket === "baseline");
    expect(outliers).toHaveLength(2);
    expect(baseline).toHaveLength(6);
    // The 2 slowest (n7=70ms, n6=60ms) are the outliers.
    expect(outliers.map((s) => s.run.id).sort()).toEqual(["n6", "n7"]);
    expect(selected).toHaveLength(8);
  });
});

describe("summarizeSample", () => {
  test("counts buckets and computes medians over BASELINE runs only", () => {
    const selected: BucketedRoot[] = [
      { bucket: "error", run: root("e", 999, 999) },
      { bucket: "outlier", run: root("o", 5000, 5000) },
      { bucket: "baseline", run: root("b1", 100, 10) },
      { bucket: "baseline", run: root("b2", 300, 30) },
      { bucket: "baseline", run: root("b3", 200, 20) },
    ];

    expect(summarizeSample(selected)).toEqual({
      baselineMedianLatencyMs: 200,
      baselineMedianTokens: 20,
      bucketCounts: { baseline: 3, error: 1, outlier: 1 },
      sampleSize: 5,
    });
  });

  test("an empty sample gives null baseline medians and zeroed buckets", () => {
    expect(summarizeSample([])).toEqual({
      baselineMedianLatencyMs: null,
      baselineMedianTokens: null,
      bucketCounts: { baseline: 0, error: 0, outlier: 0 },
      sampleSize: 0,
    });
  });
});
