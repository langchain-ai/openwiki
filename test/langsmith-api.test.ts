import type { Run } from "langsmith";
import { describe, expect, test } from "vitest";

import { isOpenWikiRun } from "../src/connectors/sources/langsmith/api.js";
import {
  CONNECTOR_IDS,
  createConnectorRegistry,
} from "../src/connectors/registry.js";

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

describe("LangSmith connector", () => {
  test("is registered as deterministic direct API ingestion", () => {
    expect(CONNECTOR_IDS).toContain("langsmith");
    expect(createConnectorRegistry().langsmith).toMatchObject({
      backend: "direct-api",
      id: "langsmith",
      requiredEnv: ["LANGSMITH_API_KEY"],
      supportsAgenticDiscovery: false,
    });
  });

  test("excludes OpenWiki traces by tag in a shared project", () => {
    expect(isOpenWikiRun(createRun({ tags: ["openwiki"] }))).toBe(true);
    expect(isOpenWikiRun(createRun({ tags: ["coding-agent"] }))).toBe(false);
  });

  test("excludes OpenWiki traces by metadata in a shared project", () => {
    expect(
      isOpenWikiRun(createRun({ extra: { metadata: { openwiki: true } } })),
    ).toBe(true);
    expect(
      isOpenWikiRun(createRun({ extra: { metadata: { openwiki: false } } })),
    ).toBe(false);
  });
});
