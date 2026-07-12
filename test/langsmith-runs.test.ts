import type { Run } from "langsmith";
import { describe, expect, test } from "vitest";

import {
  compactRun,
  computeStats,
  maxStartTime,
} from "../src/connectors/sources/langsmith/runs.js";

function createRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    name: "coding-agent",
    run_type: "chain",
    start_time: "2026-07-12T10:00:00.000Z",
    trace_id: "trace-1",
    ...overrides,
  } as Run;
}

describe("LangSmith run shaping", () => {
  test("compacts trace evidence and marks truncated fields", () => {
    const result = compactRun(
      createRun({
        end_time: "2026-07-12T10:00:01.250Z",
        inputs: { prompt: "abcdefgh" },
        outputs: { answer: "done" },
        total_tokens: 42,
      }),
      "https://smith.langchain.com/o/example/projects/p/project",
      10,
    );

    expect(result).toMatchObject({
      id: "run-1",
      latencyMs: 1250,
      name: "coding-agent",
      totalTokens: 42,
      traceUrl:
        "https://smith.langchain.com/o/example/projects/p/project/r/run-1",
    });
    expect(result.inputs).toContain("[truncated]");
  });

  test("computes internally consistent error and latency statistics", () => {
    const result = computeStats([
      createRun({ end_time: "2026-07-12T10:00:01.000Z", total_tokens: 10 }),
      createRun({
        end_time: "2026-07-12T10:00:03.000Z",
        error: "failed",
        id: "run-2",
        start_time: "2026-07-12T10:00:01.000Z",
        total_tokens: 20,
      }),
    ]);

    expect(result).toEqual({
      errorCount: 1,
      errorRate: 0.5,
      latencyMsP50: 2000,
      latencyMsP95: 2000,
      runCount: 2,
      totalTokens: 30,
    });
  });

  test("finds the latest valid run start time", () => {
    expect(
      maxStartTime([
        createRun(),
        createRun({ id: "run-2", start_time: "2026-07-12T11:00:00Z" }),
        createRun({ id: "run-3", start_time: undefined }),
      ]),
    ).toBe("2026-07-12T11:00:00.000Z");
  });
});
