import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Hoisted control surface for the mocked LangSmith SDK Client.
 */
const sdk = vi.hoisted(() => ({
  getProjectUrl: vi.fn(),
  listRunsArgs: [] as Record<string, unknown>[],
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

    readProject = sdk.readProject;
    getProjectUrl = sdk.getProjectUrl;
  }

  return { Client };
});

const { createLangSmithApi, isRateLimitError } =
  await import("../src/connectors/sources/langsmith/api.ts");

beforeEach(() => {
  sdk.runs = [];
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

describe("listRootRuns", () => {
  test("caps at limit, orders desc, and omits startTime when there is no window", async () => {
    sdk.runs = Array.from({ length: 5 }, (_, i) => ({ id: `r-${i}` }));

    const runs = await api().listRootRuns("proj-1", { limit: 3 });

    expect(runs).toHaveLength(3);
    const args = sdk.listRunsArgs[0] ?? {};
    expect(args.isRoot).toBe(true);
    expect(args.projectId).toBe("proj-1");
    expect(args.limit).toBe(3);
    expect(args.order).toBe("desc");
    expect(args.select).toContain("trace_id");
    expect(args.select).not.toContain("inputs");
    expect(args).not.toHaveProperty("startTime");
  });

  test("passes a Date startTime when a window is given", async () => {
    sdk.runs = [{ id: "a" }];

    await api().listRootRuns("proj-1", {
      limit: 5,
      startTime: "2026-07-21T00:00:00.000Z",
    });

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

describe("isRateLimitError", () => {
  test.each([
    [
      "an SDK 429 message",
      new Error(
        "Failed to fetch /runs/query. Received status [429]: Too Many Requests. Rate limit exceeded",
      ),
    ],
    ["a status property", { status: 429 }],
    ["a rate-limit phrase", new Error("Rate limit exceeded")],
  ])("detects %s", (_label, error) => {
    expect(isRateLimitError(error)).toBe(true);
  });

  test.each([
    ["a 500", new Error("Received status [500]")],
    ["a generic error", new Error("boom")],
    ["a 429-lookalike id", new Error("run 4290 not found")],
  ])("ignores %s", (_label, error) => {
    expect(isRateLimitError(error)).toBe(false);
  });
});

describe("rate-limit retry", () => {
  const rateLimit = () =>
    new Error(
      "Failed to fetch /sessions. Received status [429]: Too Many Requests. Rate limit exceeded",
    );

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("retries a 429 then succeeds", async () => {
    sdk.readProject
      .mockRejectedValueOnce(rateLimit())
      .mockResolvedValue({ id: "p-1" });
    sdk.getProjectUrl.mockResolvedValue("https://smith/p");

    const promise = api().resolveProject("proj");
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual({
      id: "p-1",
      url: "https://smith/p",
    });
    expect(sdk.readProject).toHaveBeenCalledTimes(2);
  });

  test("gives up after the attempt cap and rethrows", async () => {
    sdk.readProject.mockRejectedValue(rateLimit());

    const settled = api()
      .resolveProject("proj")
      .catch((error: unknown) => error);
    await vi.runAllTimersAsync();

    expect(String(await settled)).toMatch(/429/u);
    expect(sdk.readProject).toHaveBeenCalledTimes(5); // MAX_RETRY_ATTEMPTS
  });

  test("does not retry a non-rate-limit error", async () => {
    sdk.readProject.mockRejectedValue(new Error("boom 500"));

    const settled = api()
      .resolveProject("proj")
      .catch((error: unknown) => error);
    await vi.runAllTimersAsync();

    expect(String(await settled)).toMatch(/boom/u);
    expect(sdk.readProject).toHaveBeenCalledTimes(1);
  });
});
