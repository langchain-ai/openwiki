import type { Run } from "langsmith";
import { describe, expect, test } from "vitest";

import {
  compactRun,
  isOpenWikiRun,
} from "../src/connectors/sources/langsmith.js";
import {
  CONNECTOR_IDS,
  createConnectorRegistry,
} from "../src/connectors/registry.js";

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    name: "coding-agent",
    run_type: "chain",
    start_time: "2026-07-12T10:00:00Z",
    trace_id: "trace-1",
    ...overrides,
  } as Run;
}

describe("LangSmith connector", () => {
  test("is registered as a direct API connector", () => {
    expect(CONNECTOR_IDS).toContain("langsmith");
    expect(createConnectorRegistry().langsmith).toMatchObject({
      backend: "direct-api",
      requiredEnv: ["LANGSMITH_API_KEY"],
    });
  });

  test("filters OpenWiki traces from shared projects", () => {
    expect(isOpenWikiRun(run({ tags: ["openwiki"] }))).toBe(true);
    expect(
      isOpenWikiRun(run({ extra: { metadata: { openwiki: true } } })),
    ).toBe(true);
    expect(isOpenWikiRun(run({ tags: ["coding-agent"] }))).toBe(false);
  });

  test("compacts trace evidence with provenance", () => {
    expect(
      compactRun(
        run({ inputs: { prompt: "hello" }, outputs: { answer: "done" } }),
        "https://smith.langchain.com/project",
      ),
    ).toMatchObject({
      id: "run-1",
      inputs: '{"prompt":"hello"}',
      outputs: '{"answer":"done"}',
      traceUrl: "https://smith.langchain.com/project/r/run-1",
    });
  });
});
