import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/connectors/io.ts", () => ({
  createRunId: () => "run-1",
  readConnectorState: () => Promise.resolve({ version: 1 }),
  updateStateWithRun: (state: Record<string, unknown>, entry: unknown) => ({
    ...state,
    runs: [entry],
    version: 1,
  }),
  writeConnectorState: vi.fn(() => Promise.resolve()),
  writeRawJson: vi.fn(() =>
    Promise.resolve("/raw/langsmith/run-1/langsmith-results.json"),
  ),
}));

vi.mock("../src/connectors/sources/langsmith/api.ts", () => ({
  createLangSmithApi: vi.fn(),
}));

// Keep the real sanitizeLangSmithApiBaseUrl (the validation under test) and mock
// only the config reader.
vi.mock(
  "../src/connectors/sources/langsmith/repo-config.ts",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../src/connectors/sources/langsmith/repo-config.ts")
    >()),
    readLangSmithRepoConfig: vi.fn(),
  }),
);

import { writeRawJson } from "../src/connectors/io.ts";
import type { LangSmithApi } from "../src/connectors/sources/langsmith/api.ts";
import { createLangSmithApi } from "../src/connectors/sources/langsmith/api.ts";
import { createLangSmithConnector } from "../src/connectors/sources/langsmith/index.ts";
import type { LangSmithRepoConfig } from "../src/connectors/sources/langsmith/repo-config.ts";
import { readLangSmithRepoConfig } from "../src/connectors/sources/langsmith/repo-config.ts";
import type { Run } from "langsmith";

const KEY = "OPENWIKI_LANGSMITH_API_KEY";
const REPO = "/repo";
const saved: Record<string, string | undefined> = {};

function run(fields: Record<string, unknown>): Run {
  return fields as unknown as Run;
}

/**
 * A fully-stubbed api with empty-result defaults each test overrides.
 */
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

/**
 * Sets the committed openwiki/langsmith.json a code-mode ingest reads, or
 * undefined to model a repo that has not configured langsmith.
 */
function configureRepo(config: LangSmithRepoConfig | undefined): void {
  vi.mocked(readLangSmithRepoConfig).mockResolvedValue(config);
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

describe("ingest gating", () => {
  test("skips when called without a repoRoot (generic ingest-all)", async () => {
    const result = await createLangSmithConnector().ingest();

    expect(result.status).toBe("skipped");
    expect(readLangSmithRepoConfig).not.toHaveBeenCalled();
    expect(createLangSmithApi).not.toHaveBeenCalled();
  });

  test("skips when the repo has not configured langsmith", async () => {
    configureRepo(undefined);

    const result = await createLangSmithConnector().ingest({ repoRoot: REPO });

    expect(result.status).toBe("skipped");
    expect(createLangSmithApi).not.toHaveBeenCalled();
  });

  test("errors when configured but no API key is present", async () => {
    configureRepo({ projects: [{ name: "p" }] });

    const result = await createLangSmithConnector().ingest({ repoRoot: REPO });

    expect(result.status).toBe("error");
    expect(result.message).toContain(KEY);
  });
});

describe("ingest per-project behavior", () => {
  test("a project with no recent roots contributes nothing → skipped", async () => {
    process.env[KEY] = "lsv2_test";
    configureRepo({ projects: [{ name: "quiet" }] });
    vi.mocked(createLangSmithApi).mockReturnValue(
      fakeApi({ listRecentRootRuns: () => Promise.resolve([]) }),
    );

    const result = await createLangSmithConnector().ingest({ repoRoot: REPO });

    expect(result.status).toBe("skipped");
    expect(writeRawJson).not.toHaveBeenCalled();
  });

  test("a resolve failure becomes a warning, not a run failure", async () => {
    process.env[KEY] = "lsv2_test";
    configureRepo({ projects: [{ name: "bad" }] });
    vi.mocked(createLangSmithApi).mockReturnValue(
      fakeApi({
        resolveProject: () => Promise.reject(new Error("project not found")),
      }),
    );

    const result = await createLangSmithConnector().ingest({ repoRoot: REPO });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("bad");
  });

  test("redacts a leaked LangSmith key in a warning", async () => {
    process.env[KEY] = "lsv2_test";
    configureRepo({ projects: [{ name: "p" }] });
    const leak = "lsv2_pt_deadbeefSECRET0000";
    vi.mocked(createLangSmithApi).mockReturnValue(
      fakeApi({
        resolveProject: () =>
          Promise.reject(new Error(`auth failed with ${leak}`)),
      }),
    );

    const result = await createLangSmithConnector().ingest({ repoRoot: REPO });

    expect(result.warnings[0]).toContain("[REDACTED:LANGSMITH_API_KEY]");
    expect(result.warnings.join(" ")).not.toContain(leak);
  });

  test("a successful project yields traces and a sample summary", async () => {
    process.env[KEY] = "lsv2_test";
    configureRepo({ projects: [{ name: "prod" }] });
    const root = run({
      id: "run-a",
      start_time: "2026-07-21T00:00:00.000Z",
      status: "success",
      trace_id: "trace-a",
    });
    vi.mocked(createLangSmithApi).mockReturnValue(
      fakeApi({
        fetchTrace: () => Promise.resolve([root]),
        listRecentRootRuns: () => Promise.resolve([root]),
      }),
    );

    const result = await createLangSmithConnector().ingest({ repoRoot: REPO });

    expect(result.status).toBe("success");
    expect(writeRawJson).toHaveBeenCalledTimes(1);
    const dump = vi.mocked(writeRawJson).mock.calls[0]?.[3] as {
      projects: { stats: { sampleSize: number }; traces: unknown[] }[];
    };
    expect(dump.projects[0]?.traces).toHaveLength(1);
    expect(dump.projects[0]?.stats.sampleSize).toBe(1);
  });
});

describe("ingest apiBaseUrl validation", () => {
  test("passes an allowlisted apiBaseUrl through to the client", async () => {
    process.env[KEY] = "lsv2_test";
    configureRepo({
      apiBaseUrl: "https://eu.api.smith.langchain.com",
      projects: [{ name: "p" }],
    });
    vi.mocked(createLangSmithApi).mockReturnValue(fakeApi());

    await createLangSmithConnector().ingest({ repoRoot: REPO });

    expect(createLangSmithApi).toHaveBeenCalledWith(
      "https://eu.api.smith.langchain.com",
      "lsv2_test",
    );
  });

  test("falls back to the default host for a non-allowlisted apiBaseUrl", async () => {
    process.env[KEY] = "lsv2_test";
    configureRepo({
      apiBaseUrl: "https://attacker.example.com",
      projects: [{ name: "p" }],
    });
    vi.mocked(createLangSmithApi).mockReturnValue(fakeApi());

    await createLangSmithConnector().ingest({ repoRoot: REPO });

    expect(createLangSmithApi).toHaveBeenCalledWith(
      "https://api.smith.langchain.com",
      "lsv2_test",
    );
  });
});

describe("ingest window", () => {
  test("pulls the fixed MAX_TRACES budget (20), no window floor by default", async () => {
    process.env[KEY] = "lsv2_test";
    configureRepo({ projects: [{ name: "p" }] });
    const listRecentRootRuns = vi.fn(() => Promise.resolve<Run[]>([]));
    vi.mocked(createLangSmithApi).mockReturnValue(
      fakeApi({ listRecentRootRuns }),
    );

    await createLangSmithConnector().ingest({ repoRoot: REPO });

    expect(listRecentRootRuns).toHaveBeenCalledWith("p-id", undefined, 20);
  });

  test("applies a window floor to the pull when windowHours is set", async () => {
    process.env[KEY] = "lsv2_test";
    configureRepo({ projects: [{ name: "p" }] });
    const listRecentRootRuns = vi.fn(() => Promise.resolve<Run[]>([]));
    vi.mocked(createLangSmithApi).mockReturnValue(
      fakeApi({ listRecentRootRuns }),
    );

    await createLangSmithConnector().ingest({ repoRoot: REPO, windowHours: 3 });

    const call = listRecentRootRuns.mock.calls[0];
    expect(typeof call?.[1]).toBe("string"); // window floor, not undefined
    expect(call?.[2]).toBe(20); // fixed MAX_TRACES
  });
});
