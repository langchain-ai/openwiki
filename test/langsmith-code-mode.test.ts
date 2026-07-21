import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/connectors/sources/langsmith/repo-config.ts", () => ({
  readLangSmithRepoConfig: vi.fn(),
}));

vi.mock("../src/connectors/sources/langsmith/api.ts", () => ({
  createLangSmithApi: vi.fn(),
}));

vi.mock("../src/connectors/io.ts", () => ({
  createRunId: () => "run-1",
  readConnectorConfig: (_id: string, def: unknown) => Promise.resolve(def),
  readConnectorState: () => Promise.resolve({ version: 1 }),
  updateStateWithRun: (state: Record<string, unknown>, entry: unknown) => ({
    ...state,
    runs: [entry],
    version: 1,
  }),
  writeConnectorState: () => Promise.resolve(),
  writeRawJson: () => Promise.resolve("/raw/langsmith/run-1/results.json"),
}));

import { createLangSmithApi } from "../src/connectors/sources/langsmith/api.ts";
import {
  createLangSmithConnector,
  langSmithGuidanceText,
} from "../src/connectors/sources/langsmith/index.ts";
import { readLangSmithRepoConfig } from "../src/connectors/sources/langsmith/repo-config.ts";
import type { LangSmithApi } from "../src/connectors/sources/langsmith/api.ts";
import type { Run } from "langsmith";

const KEY = "OPENWIKI_LANGSMITH_API_KEY";
const saved: Record<string, string | undefined> = {};

function fakeApi(overrides: Partial<LangSmithApi> = {}): LangSmithApi {
  return {
    fetchFeedback: () => Promise.resolve([]),
    fetchTrace: () => Promise.resolve([]),
    listProjectNames: () => Promise.resolve([]),
    listRecentRootRuns: () => Promise.resolve([]),
    resolveProject: () =>
      Promise.resolve({ id: "p-id", url: "https://smith/p" }),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  saved[KEY] = process.env[KEY];
  delete process.env[KEY];
  delete process.env.LANGSMITH_API_KEY;
});

afterEach(() => {
  if (saved[KEY] === undefined) {
    delete process.env[KEY];
  } else {
    process.env[KEY] = saved[KEY];
  }
});

describe("langSmithGuidanceText", () => {
  test("names the projects and includes the read tool and privacy rule", () => {
    const text = langSmithGuidanceText(["prod", "staging"], []);

    expect(text).toContain("prod, staging");
    expect(text).toContain("openwiki_read_raw_item");
    expect(text).toContain("Never copy raw run inputs or outputs");
  });

  test("surfaces connector warnings", () => {
    const text = langSmithGuidanceText(["prod"], ["prod: hit the limit"]);

    expect(text).toContain("Connector warnings:");
    expect(text).toContain("prod: hit the limit");
  });
});

describe("buildCodeModeGuidance", () => {
  test("returns undefined when the repo has no langsmith config", async () => {
    vi.mocked(readLangSmithRepoConfig).mockResolvedValue(undefined);

    const guidance =
      await createLangSmithConnector().buildCodeModeGuidance?.("/repo");

    expect(guidance).toBeUndefined();
    expect(createLangSmithApi).not.toHaveBeenCalled();
  });

  test("pulls and returns guidance naming the configured projects", async () => {
    process.env[KEY] = "lsv2_test";
    vi.mocked(readLangSmithRepoConfig).mockResolvedValue({
      projects: [{ name: "prod" }],
    });
    const root = {
      id: "run-a",
      start_time: "2026-07-21T00:00:00.000Z",
      status: "success",
      trace_id: "trace-a",
    } as unknown as Run;
    vi.mocked(createLangSmithApi).mockReturnValue(
      fakeApi({
        fetchTrace: () => Promise.resolve([root]),
        listRecentRootRuns: () => Promise.resolve([root]),
      }),
    );

    const guidance =
      await createLangSmithConnector().buildCodeModeGuidance?.("/repo");

    expect(guidance).toContain("prod");
    expect(guidance).toContain("openwiki_read_raw_item");
  });
});
