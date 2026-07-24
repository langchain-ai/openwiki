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

// Keep the real sanitizers (the validation under test) and mock only the reader.
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
const KEY2 = "OPENWIKI_LANGSMITH_API_KEY_2";
const EU = "https://eu.api.smith.langchain.com";
const US = "https://api.smith.langchain.com";
const REPO = "/repo";
const MANAGED = [KEY, KEY2, "LANGSMITH_API_KEY", "AWS_SECRET_ACCESS_KEY"];
const saved: Record<string, string | undefined> = {};

function run(fields: Record<string, unknown>): Run {
  return fields as unknown as Run;
}

/**
 * A fully-stubbed api with empty-result defaults each test overrides.
 */
function fakeApi(overrides: Partial<LangSmithApi> = {}): LangSmithApi {
  return {
    fetchTrace: () => Promise.resolve([]),
    listRootRuns: () => Promise.resolve([]),
    resolveProject: () =>
      Promise.resolve({ id: "p-id", url: "https://smith/p" }),
    ...overrides,
  };
}

/**
 * A workspace config entry keyed on KEY with one project unless overridden.
 */
function workspace(
  overrides: Partial<LangSmithRepoConfig["workspaces"][number]> = {},
): LangSmithRepoConfig["workspaces"][number] {
  return { apiKeyEnv: KEY, projects: [{ name: "p" }], ...overrides };
}

/**
 * Sets the committed .langsmith.json a code-mode ingest reads, or undefined to
 * model a repo that has not configured langsmith.
 */
function configureRepo(config: LangSmithRepoConfig | undefined): void {
  vi.mocked(readLangSmithRepoConfig).mockResolvedValue(config);
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of MANAGED) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
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

  test("a workspace with no key present is a warning, not a run failure", async () => {
    configureRepo({ workspaces: [workspace()] });

    const result = await createLangSmithConnector().ingest({ repoRoot: REPO });

    expect(result.status).toBe("skipped");
    expect(result.warnings.join(" ")).toContain(KEY);
    expect(createLangSmithApi).not.toHaveBeenCalled();
  });

  test("drops a workspace whose apiKeyEnv is outside the namespace", async () => {
    // A committed config must not be able to read an unrelated secret. Even with
    // a value present, the workspace is dropped and the client never built.
    process.env.AWS_SECRET_ACCESS_KEY = "super-secret";
    configureRepo({
      workspaces: [
        { apiKeyEnv: "AWS_SECRET_ACCESS_KEY", projects: [{ name: "x" }] },
      ],
    });

    const result = await createLangSmithConnector().ingest({ repoRoot: REPO });

    expect(result.status).toBe("skipped");
    expect(createLangSmithApi).not.toHaveBeenCalled();
    expect(result.warnings.join(" ")).toContain("not an allowed");
  });
});

describe("ingest per-project behavior", () => {
  test("a project with no recent roots contributes nothing → skipped", async () => {
    process.env[KEY] = "lsv2_test";
    configureRepo({
      workspaces: [workspace({ projects: [{ name: "quiet" }] })],
    });
    vi.mocked(createLangSmithApi).mockReturnValue(
      fakeApi({ listRootRuns: () => Promise.resolve([]) }),
    );

    const result = await createLangSmithConnector().ingest({ repoRoot: REPO });

    expect(result.status).toBe("skipped");
    expect(writeRawJson).not.toHaveBeenCalled();
  });

  test("a resolve failure becomes a warning, not a run failure (fail-open)", async () => {
    process.env[KEY] = "lsv2_test";
    configureRepo({ workspaces: [workspace({ projects: [{ name: "bad" }] })] });
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
    configureRepo({ workspaces: [workspace()] });
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
    configureRepo({
      workspaces: [workspace({ projects: [{ name: "prod" }] })],
    });
    const root = run({
      id: "run-a",
      start_time: "2026-07-21T00:00:00.000Z",
      status: "success",
      trace_id: "trace-a",
    });
    vi.mocked(createLangSmithApi).mockReturnValue(
      fakeApi({
        fetchTrace: () => Promise.resolve([root]),
        listRootRuns: () => Promise.resolve([root]),
      }),
    );

    const result = await createLangSmithConnector().ingest({ repoRoot: REPO });

    expect(result.status).toBe("success");
    expect(writeRawJson).toHaveBeenCalledTimes(1);
    const dump = vi.mocked(writeRawJson).mock.calls[0]?.[3] as {
      projects: {
        apiBaseUrl: string;
        stats: { sampleSize: number };
        traces: unknown[];
      }[];
    };
    expect(dump.projects[0]?.traces).toHaveLength(1);
    expect(dump.projects[0]?.stats.sampleSize).toBe(1);
    expect(dump.projects[0]?.apiBaseUrl).toBe(US);
  });

  test("tags dump traces with their sampling bucket and records bucket counts", async () => {
    process.env[KEY] = "lsv2_test";
    configureRepo({
      workspaces: [workspace({ projects: [{ name: "prod" }] })],
    });
    const errorRoot = run({
      id: "run-err",
      start_time: "2026-07-21T00:00:00.000Z",
      status: "error",
      trace_id: "trace-err",
    });
    const normalRoot = run({
      id: "run-ok",
      start_time: "2026-07-21T00:00:01.000Z",
      status: "success",
      trace_id: "trace-ok",
    });
    vi.mocked(createLangSmithApi).mockReturnValue(
      fakeApi({
        listRootRuns: () => Promise.resolve([errorRoot, normalRoot]),
        fetchTrace: (traceId: string) =>
          Promise.resolve(traceId === "trace-err" ? [errorRoot] : [normalRoot]),
      }),
    );

    await createLangSmithConnector().ingest({ repoRoot: REPO });

    const dump = vi.mocked(writeRawJson).mock.calls[0]?.[3] as {
      projects: {
        stats: { bucketCounts: Record<string, number> };
        traces: { bucket: string; isError: boolean }[];
      }[];
    };
    const buckets = dump.projects[0]?.traces.map((t) => t.bucket) ?? [];
    expect(buckets).toContain("error");
    expect(dump.projects[0]?.stats.bucketCounts.error).toBe(1);
    const errorTrace = dump.projects[0]?.traces.find(
      (t) => t.bucket === "error",
    );
    expect(errorTrace?.isError).toBe(true);
  });

  test("one failed trace fetch warns but the rest of the project still pulls (fail-open)", async () => {
    process.env[KEY] = "lsv2_test";
    configureRepo({
      workspaces: [workspace({ projects: [{ name: "prod" }] })],
    });
    const good = run({
      id: "run-good",
      start_time: "2026-07-21T00:00:00.000Z",
      status: "success",
      trace_id: "trace-good",
    });
    const bad = run({
      id: "run-bad",
      start_time: "2026-07-21T00:00:01.000Z",
      status: "success",
      trace_id: "trace-bad",
    });
    vi.mocked(createLangSmithApi).mockReturnValue(
      fakeApi({
        listRootRuns: () => Promise.resolve([good, bad]),
        fetchTrace: (traceId: string) =>
          traceId === "trace-bad"
            ? Promise.reject(new Error("trace fetch timed out"))
            : Promise.resolve([good]),
      }),
    );

    const result = await createLangSmithConnector().ingest({ repoRoot: REPO });

    expect(result.status).toBe("success");
    expect(result.warnings.join(" ")).toContain("skipped a trace");
    const dump = vi.mocked(writeRawJson).mock.calls[0]?.[3] as {
      projects: { stats: { sampleSize: number }; traces: unknown[] }[];
    };
    // The good trace still lands; stats reflect both roots (fetched fine).
    expect(dump.projects[0]?.traces).toHaveLength(1);
    expect(dump.projects[0]?.stats.sampleSize).toBe(2);
  });
});

describe("multiple workspaces", () => {
  const root = run({
    id: "r",
    start_time: "2026-07-21T00:00:00.000Z",
    status: "success",
    trace_id: "t",
  });

  test("pulls each workspace with its own key and host", async () => {
    process.env[KEY] = "us_key";
    process.env[KEY2] = "eu_key";
    configureRepo({
      workspaces: [
        workspace({ projects: [{ name: "us-proj" }] }),
        { apiBaseUrl: EU, apiKeyEnv: KEY2, projects: [{ name: "eu-proj" }] },
      ],
    });
    vi.mocked(createLangSmithApi).mockReturnValue(
      fakeApi({
        fetchTrace: () => Promise.resolve([root]),
        listRootRuns: () => Promise.resolve([root]),
      }),
    );

    const result = await createLangSmithConnector().ingest({ repoRoot: REPO });

    expect(result.status).toBe("success");
    expect(createLangSmithApi).toHaveBeenCalledWith(US, "us_key");
    expect(createLangSmithApi).toHaveBeenCalledWith(EU, "eu_key");
  });

  test("a workspace missing its key warns but others still pull (fail-open)", async () => {
    process.env[KEY] = "us_key"; // KEY2 unset
    configureRepo({
      workspaces: [
        workspace({ projects: [{ name: "us-proj" }] }),
        { apiBaseUrl: EU, apiKeyEnv: KEY2, projects: [{ name: "eu-proj" }] },
      ],
    });
    vi.mocked(createLangSmithApi).mockReturnValue(
      fakeApi({
        fetchTrace: () => Promise.resolve([root]),
        listRootRuns: () => Promise.resolve([root]),
      }),
    );

    const result = await createLangSmithConnector().ingest({ repoRoot: REPO });

    expect(result.status).toBe("success");
    expect(result.warnings.join(" ")).toContain(KEY2);
    expect(createLangSmithApi).toHaveBeenCalledTimes(1);
    expect(createLangSmithApi).toHaveBeenCalledWith(US, "us_key");
  });
});

describe("ingest window", () => {
  test("pulls the SAMPLE_LOOKBACK batch (50), no window floor by default", async () => {
    process.env[KEY] = "lsv2_test";
    configureRepo({ workspaces: [workspace()] });
    const listRootRuns = vi.fn(() => Promise.resolve<Run[]>([]));
    vi.mocked(createLangSmithApi).mockReturnValue(fakeApi({ listRootRuns }));

    await createLangSmithConnector().ingest({ repoRoot: REPO });

    const call = listRootRuns.mock.calls[0];
    expect(call?.[0]).toBe("p-id");
    expect(call?.[1]?.limit).toBe(50); // SAMPLE_LOOKBACK, classified client-side
    expect(call?.[1]?.startTime).toBeUndefined(); // no window floor
  });

  test("applies a window floor to the pull when windowHours is set", async () => {
    process.env[KEY] = "lsv2_test";
    configureRepo({ workspaces: [workspace()] });
    const listRootRuns = vi.fn(() => Promise.resolve<Run[]>([]));
    vi.mocked(createLangSmithApi).mockReturnValue(fakeApi({ listRootRuns }));

    await createLangSmithConnector().ingest({ repoRoot: REPO, windowHours: 3 });

    const call = listRootRuns.mock.calls[0];
    expect(typeof call?.[1]?.startTime).toBe("string"); // window floor, not undefined
    expect(call?.[1]?.limit).toBe(50); // SAMPLE_LOOKBACK
  });
});

describe("ingest apiBaseUrl validation", () => {
  test("passes an allowlisted apiBaseUrl through to the client", async () => {
    process.env[KEY] = "lsv2_test";
    configureRepo({ workspaces: [workspace({ apiBaseUrl: EU })] });
    vi.mocked(createLangSmithApi).mockReturnValue(fakeApi());

    await createLangSmithConnector().ingest({ repoRoot: REPO });

    expect(createLangSmithApi).toHaveBeenCalledWith(EU, "lsv2_test");
  });

  test("falls back to the default host for a non-allowlisted apiBaseUrl", async () => {
    process.env[KEY] = "lsv2_test";
    configureRepo({
      workspaces: [workspace({ apiBaseUrl: "https://attacker.example.com" })],
    });
    vi.mocked(createLangSmithApi).mockReturnValue(fakeApi());

    await createLangSmithConnector().ingest({ repoRoot: REPO });

    expect(createLangSmithApi).toHaveBeenCalledWith(US, "lsv2_test");
  });
});
