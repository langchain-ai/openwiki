import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Hoisted control surface for the mocked LangSmith SDK Client.
 */
const sdk = vi.hoisted(() => ({
  feedback: [] as unknown[],
  getProjectUrl: vi.fn(),
  listFeedbackArgs: [] as Record<string, unknown>[],
  listRunsArgs: [] as Record<string, unknown>[],
  projects: [] as unknown[],
  readProject: vi.fn(),
  runs: [] as unknown[],
}));

vi.mock("langsmith", () => {
  // Sync generators suffice: the api layer consumes them via `for await`.
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
  sdk.feedback = [];
  sdk.projects = [];
  sdk.runs = [];
  sdk.listFeedbackArgs = [];
  sdk.listRunsArgs = [];
  sdk.getProjectUrl.mockReset();
  sdk.readProject.mockReset();
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

describe("listRecentRootRuns", () => {
  test("caps at limit and omits startTime when there is no window", async () => {
    sdk.runs = Array.from({ length: 5 }, (_, i) => ({ id: `r-${i}` }));

    const runs = await api().listRecentRootRuns("proj-1", undefined, 3);

    expect(runs).toHaveLength(3);
    const args = sdk.listRunsArgs[0] ?? {};
    expect(args.isRoot).toBe(true);
    expect(args.projectId).toBe("proj-1");
    expect(args.limit).toBe(3);
    expect(args.select).toContain("trace_id");
    expect(args).not.toHaveProperty("startTime");
  });

  test("passes a Date startTime when a window is given", async () => {
    sdk.runs = [{ id: "a" }];

    await api().listRecentRootRuns("proj-1", "2026-07-21T00:00:00.000Z", 5);

    expect(sdk.listRunsArgs[0]?.startTime).toBeInstanceOf(Date);
  });
});

describe("fetchTrace", () => {
  test("passes the trace id and caps at MAX_TRACE_RUNS", async () => {
    sdk.runs = Array.from({ length: 600 }, (_, i) => ({ id: `r-${i}` }));

    const runs = await api().fetchTrace("trace-1");

    expect(sdk.listRunsArgs[0]?.traceId).toBe("trace-1");
    expect(runs).toHaveLength(500);
  });
});

describe("fetchFeedback", () => {
  test("caps at MAX_FEEDBACK", async () => {
    sdk.feedback = Array.from({ length: 150 }, (_, i) => ({ id: `f-${i}` }));

    expect(await api().fetchFeedback(["run-1"])).toHaveLength(100);
  });
});

describe("listProjectNames", () => {
  test("returns named projects sorted, dropping unnamed", async () => {
    sdk.projects = [{ name: "beta" }, { name: "" }, { name: "alpha" }, {}];

    expect(await api().listProjectNames()).toEqual(["alpha", "beta"]);
  });
});
