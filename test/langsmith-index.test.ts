import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock the IO layer so ingest never touches the filesystem. Matching the ".ts"
// specifier the test importer uses resolves to the same module index.ts loads
// via "../../io.js".
vi.mock("../src/connectors/io.ts", () => ({
  createRunId: () => "run-1",
  readConnectorConfig: vi.fn(),
  readConnectorState: () => Promise.resolve({ version: 1 }),
  updateStateWithRun: (state: Record<string, unknown>, entry: unknown) => ({
    ...state,
    runs: [entry],
    version: 1,
  }),
  writeConnectorState: () => Promise.resolve(),
  writeRawJson: vi.fn(() =>
    Promise.resolve("/raw/langsmith/run-1/langsmith-results.json"),
  ),
}));

vi.mock("../src/connectors/sources/langsmith/api.ts", () => ({
  createLangSmithApi: vi.fn(),
}));

import { readConnectorConfig, writeRawJson } from "../src/connectors/io.ts";
import type { LangSmithApi } from "../src/connectors/sources/langsmith/api.ts";
import { createLangSmithApi } from "../src/connectors/sources/langsmith/api.ts";
import { createLangSmithConnector } from "../src/connectors/sources/langsmith/index.ts";

const KEY = "OPENWIKI_LANGSMITH_API_KEY";
const saved: Record<string, string | undefined> = {};

/**
 * A fully-stubbed LangSmith api, with empty-result defaults each test overrides.
 */
function fakeApi(overrides: Partial<LangSmithApi> = {}): LangSmithApi {
  return {
    fetchFeedback: () => Promise.resolve([]),
    listProjectNames: () => Promise.resolve([]),
    queryRootRuns: () => Promise.resolve([]),
    resolveProject: () =>
      Promise.resolve({ id: "p-id", url: "https://smith/p" }),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  saved[KEY] = process.env[KEY];
  saved.LANGSMITH_API_KEY = process.env.LANGSMITH_API_KEY;
  delete process.env[KEY];
  delete process.env.LANGSMITH_API_KEY;
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

/**
 * Points readConnectorConfig at a given config for the next ingest call.
 */
function configure(config: Record<string, unknown>): void {
  vi.mocked(readConnectorConfig).mockResolvedValue(config);
}

describe("ingest gating", () => {
  test("skips when the connector is disabled", async () => {
    configure({ enabled: false, projects: ["p"] });

    const result = await createLangSmithConnector().ingest();

    expect(result.status).toBe("skipped");
    expect(result.message).toContain("not enabled");
    expect(createLangSmithApi).not.toHaveBeenCalled();
  });

  test("errors when enabled but no API key is present", async () => {
    configure({ enabled: true, projects: ["p"] });

    const result = await createLangSmithConnector().ingest();

    expect(result.status).toBe("error");
    expect(result.message).toContain(KEY);
    expect(createLangSmithApi).not.toHaveBeenCalled();
  });

  test("skips when enabled and keyed but no projects are configured", async () => {
    process.env[KEY] = "lsv2_test_key";
    configure({ enabled: true, projects: [] });

    const result = await createLangSmithConnector().ingest();

    expect(result.status).toBe("skipped");
    expect(result.message).toContain("No LangSmith projects");
  });
});

describe("ingest per-project resilience", () => {
  test("turns one project's failure into a warning, not a run failure", async () => {
    process.env[KEY] = "lsv2_test_key";
    configure({ enabled: true, projects: ["good", "bad"] });
    vi.mocked(createLangSmithApi).mockReturnValue(
      fakeApi({
        resolveProject: (name: string) =>
          name === "bad"
            ? Promise.reject(new Error("project not found"))
            : Promise.resolve({ id: "good-id", url: "https://smith/good" }),
      }),
    );

    const result = await createLangSmithConnector().ingest();

    // The healthy project still produces a raw dump, so the run succeeds.
    expect(result.status).toBe("success");
    expect(writeRawJson).toHaveBeenCalledTimes(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("bad");
  });

  test("redacts a leaked LangSmith key in a per-project warning", async () => {
    process.env[KEY] = "lsv2_test_key";
    configure({ enabled: true, projects: ["p"] });
    const leak = "lsv2_pt_deadbeefSECRET0000";
    vi.mocked(createLangSmithApi).mockReturnValue(
      fakeApi({
        resolveProject: () =>
          Promise.reject(new Error(`auth failed with ${leak}`)),
      }),
    );

    const result = await createLangSmithConnector().ingest();

    expect(result.warnings[0]).toContain("[REDACTED:LANGSMITH_API_KEY]");
    expect(result.warnings.join(" ")).not.toContain(leak);
  });
});
