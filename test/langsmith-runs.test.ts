import { describe, expect, test } from "vitest";
import {
  compactTrace,
  summarizeSample,
} from "../src/connectors/sources/langsmith/runs.ts";
import type { Run } from "langsmith";

function run(fields: Record<string, unknown>): Run {
  return fields as unknown as Run;
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

    const trace = compactTrace(runs, "https://smith/p", 2000, false);

    expect(trace?.traceId).toBe("trace-1");
    expect(trace?.traceUrl).toBe("https://smith/p/r/root");
    expect(trace?.isError).toBe(false);
    expect(trace?.runs.map((r) => r.id)).toEqual([
      "root",
      "child-a",
      "child-b",
    ]);
  });

  test("marks isError when the root run failed", () => {
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
      2000,
      false,
    );

    expect(trace?.isError).toBe(true);
  });

  test("omits inputs/outputs when includePayloads is false", () => {
    const trace = compactTrace(
      [
        run({
          id: "root",
          inputs: { q: "hi" },
          outputs: { a: "yo" },
          parent_run_id: null,
          trace_id: "t",
        }),
      ],
      "https://smith/p",
      2000,
      false,
    );

    expect(trace?.runs[0]?.inputs).toBeUndefined();
    expect(trace?.runs[0]?.outputs).toBeUndefined();
  });

  test("includes truncated payloads when includePayloads is true", () => {
    const long = "x".repeat(5000);
    const trace = compactTrace(
      [
        run({
          id: "root",
          inputs: long,
          outputs: "short",
          parent_run_id: null,
          trace_id: "t",
        }),
      ],
      "https://smith/p",
      100,
      true,
    );

    expect(trace?.runs[0]?.inputs).toContain("[truncated]");
    expect(trace?.runs[0]?.inputs?.length).toBeLessThan(long.length);
    expect(trace?.runs[0]?.outputs).toBe("short");
  });

  test("returns undefined for an empty trace", () => {
    expect(compactTrace([], "https://smith/p", 2000, false)).toBeUndefined();
  });
});

describe("summarizeSample", () => {
  test("computes size, error count, median latency, and token totals", () => {
    const roots = [
      run({
        end_time: "2026-07-21T00:00:00.100Z",
        id: "a",
        start_time: "2026-07-21T00:00:00.000Z",
        status: "success",
        total_tokens: 10,
      }),
      run({
        end_time: "2026-07-21T00:00:00.300Z",
        id: "b",
        start_time: "2026-07-21T00:00:00.000Z",
        status: "error",
        total_tokens: 20,
      }),
      run({
        end_time: "2026-07-21T00:00:00.200Z",
        error: "boom",
        id: "c",
        start_time: "2026-07-21T00:00:00.000Z",
        total_tokens: 30,
      }),
    ];

    expect(summarizeSample(roots)).toEqual({
      errorCount: 2,
      medianLatencyMs: 200,
      sampleSize: 3,
      totalTokens: 60,
    });
  });

  test("an empty sample gives median null and zeros", () => {
    expect(summarizeSample([])).toEqual({
      errorCount: 0,
      medianLatencyMs: null,
      sampleSize: 0,
      totalTokens: 0,
    });
  });
});
