import { describe, expect, test } from "vitest";
import {
  compactTrace,
  maxStartTime,
  summarizeSample,
} from "../src/connectors/sources/langsmith/runs.ts";
import type { Run } from "langsmith";

/**
 * Builds a Run-shaped fixture; tests set only the fields runs.ts reads.
 */
function run(fields: Record<string, unknown>): Run {
  return fields as unknown as Run;
}

const PROJECT_URL = "https://smith.langchain.com/o/x/projects/p/proj-1";
const BASE = Date.parse("2026-07-21T00:00:00.000Z");

describe("compactTrace", () => {
  test("orders by start time (root first) and sets traceId/traceUrl/isError", () => {
    const root = run({
      end_time: BASE + 300,
      id: "r0",
      start_time: BASE,
      status: "success",
      trace_id: "t1",
    });
    const child1 = run({
      id: "r1",
      name: "toolA",
      parent_run_id: "r0",
      run_type: "tool",
      start_time: BASE + 100,
      trace_id: "t1",
    });
    const child2 = run({
      id: "r2",
      name: "llm",
      parent_run_id: "r0",
      run_type: "llm",
      start_time: BASE + 50,
      trace_id: "t1",
    });

    const trace = compactTrace(
      [child1, root, child2],
      PROJECT_URL,
      2000,
      false,
    );

    expect(trace?.traceId).toBe("t1");
    expect(trace?.traceUrl).toBe(`${PROJECT_URL}/r/r0`);
    expect(trace?.isError).toBe(false);
    expect(trace?.runs.map((r) => r.id)).toEqual(["r0", "r2", "r1"]);
    expect(trace?.runs[1]?.runType).toBe("llm");
  });

  test("marks isError when the root run failed", () => {
    const root = run({
      error: "boom",
      id: "r0",
      start_time: BASE,
      status: "error",
      trace_id: "t1",
    });
    expect(compactTrace([root], PROJECT_URL, 2000, false)?.isError).toBe(true);
  });

  test("omits payloads unless includePayloads is true, truncating when included", () => {
    const root = run({
      id: "r0",
      inputs: "x".repeat(20),
      outputs: "y".repeat(20),
      start_time: BASE,
      trace_id: "t1",
    });

    const without = compactTrace([root], PROJECT_URL, 10, false);
    expect(without?.runs[0]?.inputs).toBeUndefined();
    expect(without?.runs[0]?.outputs).toBeUndefined();

    const withPayloads = compactTrace([root], PROJECT_URL, 10, true);
    expect(withPayloads?.runs[0]?.inputs).toBe(`${"x".repeat(10)}…[truncated]`);
    expect(withPayloads?.runs[0]?.outputs).toBe(
      `${"y".repeat(10)}…[truncated]`,
    );
  });

  test("returns undefined for an empty trace", () => {
    expect(compactTrace([], PROJECT_URL, 2000, false)).toBeUndefined();
  });
});

describe("summarizeSample", () => {
  function timed(latency: number, tokens: number, errored = false): Run {
    return run({
      end_time: BASE + latency,
      error: errored ? "failed" : undefined,
      id: `r-${latency}`,
      start_time: BASE,
      status: errored ? "error" : "success",
      total_tokens: tokens,
    });
  }

  test("computes sample size, error count, median latency, and tokens", () => {
    const stats = summarizeSample([
      timed(100, 10),
      timed(200, 20),
      timed(300, 30, true),
    ]);
    expect(stats.sampleSize).toBe(3);
    expect(stats.errorCount).toBe(1);
    expect(stats.medianLatencyMs).toBe(200);
    expect(stats.totalTokens).toBe(60);
  });

  test("averages the two middle latencies for an even sample", () => {
    const stats = summarizeSample([
      timed(100, 0),
      timed(200, 0),
      timed(300, 0),
      timed(400, 0),
    ]);
    expect(stats.medianLatencyMs).toBe(250);
  });

  test("counts a failure by error text even when status is not error", () => {
    const stats = summarizeSample([
      run({ error: "late failure", id: "a", status: "success" }),
      run({ id: "b", status: "success" }),
    ]);
    expect(stats.errorCount).toBe(1);
  });

  test("returns zeros and a null median for an empty sample", () => {
    expect(summarizeSample([])).toEqual({
      errorCount: 0,
      medianLatencyMs: null,
      sampleSize: 0,
      totalTokens: 0,
    });
  });
});

describe("maxStartTime", () => {
  test("returns the latest start time as ISO", () => {
    expect(
      maxStartTime([
        run({ id: "a", start_time: "2026-07-21T00:00:01.000Z" }),
        run({ id: "b", start_time: "2026-07-21T00:00:03.000Z" }),
        run({ id: "c", start_time: "2026-07-21T00:00:02.000Z" }),
      ]),
    ).toBe("2026-07-21T00:00:03.000Z");
  });

  test("returns undefined for empty or timestamp-less runs", () => {
    expect(maxStartTime([])).toBeUndefined();
    expect(maxStartTime([run({ id: "a" })])).toBeUndefined();
  });
});
