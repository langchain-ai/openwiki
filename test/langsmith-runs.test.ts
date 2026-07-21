import { describe, expect, test } from "vitest";
import {
  compactRun,
  computeStats,
  maxStartTime,
} from "../src/connectors/sources/langsmith/runs.ts";
import type { Run } from "langsmith";

/**
 * Builds a Run-shaped fixture. The SDK's Run is wide; tests only set the fields
 * runs.ts reads, so a loose cast keeps fixtures readable.
 */
function run(fields: Record<string, unknown>): Run {
  return fields as unknown as Run;
}

const PROJECT_URL = "https://smith.langchain.com/o/x/projects/p/proj-1";

describe("compactRun", () => {
  test("omits inputs/outputs when includePayloads is false", () => {
    const compact = compactRun(
      run({
        id: "run-1",
        inputs: { prompt: "secret question" },
        outputs: { answer: "secret answer" },
        name: "agent",
        status: "success",
      }),
      PROJECT_URL,
      2000,
      false,
    );

    expect(compact.inputs).toBeUndefined();
    expect(compact.outputs).toBeUndefined();
    expect(compact.id).toBe("run-1");
    expect(compact.name).toBe("agent");
    expect(compact.traceUrl).toBe(`${PROJECT_URL}/r/run-1`);
  });

  test("includes payloads, truncated to maxFieldChars, when enabled", () => {
    const compact = compactRun(
      run({
        id: "run-2",
        inputs: "x".repeat(20),
        outputs: "y".repeat(20),
      }),
      PROJECT_URL,
      10,
      true,
    );

    expect(compact.inputs).toBe(`${"x".repeat(10)}…[truncated]`);
    expect(compact.outputs).toBe(`${"y".repeat(10)}…[truncated]`);
  });

  test("truncates the error field and normalizes timestamps to ISO", () => {
    const compact = compactRun(
      run({
        id: "run-3",
        error: "boom ".repeat(10),
        start_time: "2026-07-20T00:00:00.000Z",
        end_time: 1_753_000_000_500,
      }),
      PROJECT_URL,
      12,
      false,
    );

    expect(compact.error).toBe("boom boom bo…[truncated]");
    expect(compact.startTime).toBe("2026-07-20T00:00:00.000Z");
    // Numeric end_time is coerced to an ISO string.
    expect(compact.endTime).toBe(new Date(1_753_000_000_500).toISOString());
  });
});

describe("computeStats", () => {
  const base = Date.parse("2026-07-20T00:00:00.000Z");

  /**
   * A run with a fixed latency (ms), token count, and error state.
   */
  function timedRun(
    latencyMs: number,
    totalTokens: number,
    errored = false,
  ): Run {
    return run({
      id: `run-${latencyMs}`,
      start_time: base,
      end_time: base + latencyMs,
      total_tokens: totalTokens,
      status: errored ? "error" : "success",
      error: errored ? "failed" : undefined,
    });
  }

  test("computes error rate, token total, and nearest-rank p50/p95", () => {
    const stats = computeStats([
      timedRun(100, 10),
      timedRun(200, 20),
      timedRun(300, 30, true),
      timedRun(400, 40),
    ]);

    expect(stats.runCount).toBe(4);
    expect(stats.errorCount).toBe(1);
    expect(stats.errorRate).toBe(0.25);
    expect(stats.totalTokens).toBe(100);
    // sorted latencies [100,200,300,400]: p50 -> index 2, p95 -> index 3.
    expect(stats.latencyMsP50).toBe(300);
    expect(stats.latencyMsP95).toBe(400);
  });

  test("returns zeros and null latencies for an empty sample", () => {
    expect(computeStats([])).toEqual({
      errorCount: 0,
      errorRate: 0,
      latencyMsP50: null,
      latencyMsP95: null,
      runCount: 0,
      totalTokens: 0,
    });
  });

  test("counts a run as failed on either error text or error status", () => {
    const stats = computeStats([
      run({ id: "a", status: "success", error: "late failure" }),
      run({ id: "b", status: "error" }),
      run({ id: "c", status: "success" }),
    ]);

    expect(stats.errorCount).toBe(2);
    expect(stats.errorRate).toBe(0.67);
  });
});

describe("maxStartTime", () => {
  test("returns the latest start time as ISO for the cursor", () => {
    expect(
      maxStartTime([
        run({ id: "a", start_time: "2026-07-20T00:00:01.000Z" }),
        run({ id: "b", start_time: "2026-07-20T00:00:03.000Z" }),
        run({ id: "c", start_time: "2026-07-20T00:00:02.000Z" }),
      ]),
    ).toBe("2026-07-20T00:00:03.000Z");
  });

  test("returns undefined for an empty list or runs without start times", () => {
    expect(maxStartTime([])).toBeUndefined();
    expect(maxStartTime([run({ id: "a" }), run({ id: "b" })])).toBeUndefined();
  });
});
