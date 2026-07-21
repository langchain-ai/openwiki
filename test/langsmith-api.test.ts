import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Shared, hoisted control surface for the mocked LangSmith SDK Client. Tests set
 * what each streaming method yields and inspect the arguments the api layer
 * passed through.
 */
const sdk = vi.hoisted(() => ({
  runs: [] as unknown[],
  feedback: [] as unknown[],
  projects: [] as unknown[],
  listRunsArgs: [] as Record<string, unknown>[],
  listFeedbackArgs: [] as Record<string, unknown>[],
  readProject: vi.fn(),
  getProjectUrl: vi.fn(),
}));

vi.mock("langsmith", () => {
  // Sync generators are enough: the api layer consumes them via `for await`,
  // which accepts sync iterables, and they keep the mock free of no-op awaits.
  class Client {
    constructor() {}

    *listRuns(args: Record<string, unknown>) {
      sdk.listRunsArgs.push(args);
      yield* sdk.runs;
    }

    *listFeedback(args: Record<string, unknown>) {
      sdk.listFeedbackArgs.push(args);
      yield* sdk.feedback;
    }

    *listProjects() {
      yield* sdk.projects;
    }

    readProject = sdk.readProject;
    getProjectUrl = sdk.getProjectUrl;
  }

  return { Client };
});

const { createLangSmithApi } =
  await import("../src/connectors/sources/langsmith/api.ts");

beforeEach(() => {
  sdk.runs = [];
  sdk.feedback = [];
  sdk.projects = [];
  sdk.listRunsArgs = [];
  sdk.listFeedbackArgs = [];
  sdk.readProject.mockReset();
  sdk.getProjectUrl.mockReset();
});

function api() {
  return createLangSmithApi("https://api.smith.langchain.com", "lsv2_test_key");
}

describe("resolveProject", () => {
  test("maps a project name to its UUID and URL", async () => {
    sdk.readProject.mockResolvedValue({ id: "proj-123" });
    sdk.getProjectUrl.mockResolvedValue(
      "https://smith.langchain.com/o/x/projects/p/proj-123",
    );

    const resolved = await api().resolveProject("my-project");

    expect(sdk.readProject).toHaveBeenCalledWith({ projectName: "my-project" });
    expect(sdk.getProjectUrl).toHaveBeenCalledWith({ projectId: "proj-123" });
    expect(resolved).toEqual({
      id: "proj-123",
      url: "https://smith.langchain.com/o/x/projects/p/proj-123",
    });
  });
});

describe("queryRootRuns", () => {
  test("passes error:true and a Date startTime when errorOnly", async () => {
    sdk.runs = [{ id: "a" }, { id: "b" }];

    const runs = await api().queryRootRuns("proj-1", {
      errorOnly: true,
      limit: 10,
      startTime: "2026-07-20T00:00:00.000Z",
    });

    expect(runs).toHaveLength(2);
    const args = sdk.listRunsArgs[0] ?? {};
    expect(args.error).toBe(true);
    expect(args.isRoot).toBe(true);
    expect(args.projectId).toBe("proj-1");
    expect(args.limit).toBe(10);
    expect(args.select).toContain("total_tokens");
    expect(args.startTime).toBeInstanceOf(Date);
  });

  test("omits the error filter when errorOnly is false", async () => {
    sdk.runs = [{ id: "a" }];

    await api().queryRootRuns("proj-1", {
      errorOnly: false,
      limit: 5,
      startTime: "2026-07-20T00:00:00.000Z",
    });

    expect(sdk.listRunsArgs[0]).not.toHaveProperty("error");
  });

  test("stops at the limit even when the stream yields more", async () => {
    sdk.runs = Array.from({ length: 5 }, (_, i) => ({ id: `run-${i}` }));

    const runs = await api().queryRootRuns("proj-1", {
      errorOnly: false,
      limit: 3,
      startTime: "2026-07-20T00:00:00.000Z",
    });

    expect(runs).toHaveLength(3);
  });
});

describe("fetchFeedback", () => {
  test("caps runIds and total entries", async () => {
    sdk.feedback = Array.from({ length: 150 }, (_, i) => ({ id: `f-${i}` }));
    const runIds = Array.from({ length: 30 }, (_, i) => `run-${i}`);

    const feedback = await api().fetchFeedback(runIds);

    // runIds are sliced to MAX_FEEDBACK_RUNS (20) before the query.
    expect((sdk.listFeedbackArgs[0]?.runIds as string[]).length).toBe(20);
    // total is capped at MAX_FEEDBACK_RUNS * MAX_FEEDBACK_PER_RUN (100).
    expect(feedback).toHaveLength(100);
  });
});

describe("listProjectNames", () => {
  test("returns named projects sorted, dropping unnamed ones", async () => {
    sdk.projects = [{ name: "beta" }, { name: "" }, { name: "alpha" }, {}];

    expect(await api().listProjectNames()).toEqual(["alpha", "beta"]);
  });
});
