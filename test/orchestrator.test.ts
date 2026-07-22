import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The orchestrator drives runs through the extracted runOne wrapper and does its
 * once-per-process setup via loadOpenWikiEnv / syncBundledSkills /
 * ensureCodeModeRepoSetup / resolveRunModel / refreshChatGptTokensIfNeeded. We
 * mock all of those to record call order and counts without touching a model.
 */
const calls: string[] = [];

const defaultRunOneImpl = (
  command: string,
  cwd: string,
  options: { recursionRole?: string },
): Promise<{ command: string; model: string }> => {
  calls.push(`runOne:${options.recursionRole ?? "none"}:${cwd}`);
  return Promise.resolve({ command, model: "test-model" });
};

const runOneMock = vi.fn(defaultRunOneImpl);
const resolveRunModelMock = vi.fn(() => {
  calls.push("resolveRunModel");
  return {
    provider: "openai",
    modelId: "test-model",
    providerRetryAttempts: 0,
  };
});
const refreshMock = vi.fn((): Promise<void> => {
  calls.push("refreshChatGpt");
  return Promise.resolve();
});

vi.mock("../src/agent/index.ts", () => ({
  runOne: runOneMock,
  resolveRunModel: resolveRunModelMock,
  refreshChatGptTokensIfNeeded: refreshMock,
}));

const loadEnvMock = vi.fn((): Promise<void> => {
  calls.push("loadOpenWikiEnv");
  return Promise.resolve();
});
vi.mock("../src/env.ts", () => ({
  loadOpenWikiEnv: loadEnvMock,
}));

const syncSkillsMock = vi.fn((): Promise<void> => {
  calls.push("syncBundledSkills");
  return Promise.resolve();
});
vi.mock("../src/agent/skills.ts", () => ({
  syncBundledSkills: syncSkillsMock,
}));

const ensureSetupMock = vi.fn((): Promise<void> => {
  calls.push("ensureCodeModeRepoSetup");
  return Promise.resolve();
});
vi.mock("../src/code-mode.ts", () => ({
  ensureCodeModeRepoSetup: ensureSetupMock,
}));

// Import AFTER mocks are registered.
const { runRecursiveOpenWiki } =
  await import("../src/monorepo/orchestrator.ts");
const { resolveWorkspaceRuns } = await import("../src/monorepo/workspaces.ts");

const tempDirs: string[] = [];

async function createMonorepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "openwiki-orch-"));
  tempDirs.push(repo);
  for (const pkg of ["a", "b"]) {
    await mkdir(path.join(repo, "packages", pkg), { recursive: true });
    await writeFile(
      path.join(repo, "packages", pkg, "package.json"),
      "{}",
      "utf8",
    );
  }
  return repo;
}

beforeEach(() => {
  runOneMock.mockImplementation(defaultRunOneImpl);
});

afterEach(async () => {
  calls.length = 0;
  vi.clearAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("runRecursiveOpenWiki ordering", () => {
  test("runs subprojects then root, once each of the shared setup steps", async () => {
    const repo = await createMonorepo();
    const manifest = {
      version: 1,
      workspaces: [{ path: "packages/a" }, { path: "packages/b" }],
    } as const;

    const result = await runRecursiveOpenWiki(
      "init",
      repo,
      { outputMode: "repository" },
      manifest,
    );

    // Shared once-only setup happens exactly once.
    expect(loadEnvMock).toHaveBeenCalledTimes(1);
    expect(syncSkillsMock).toHaveBeenCalledTimes(1);
    expect(ensureSetupMock).toHaveBeenCalledTimes(1);
    expect(resolveRunModelMock).toHaveBeenCalledTimes(1);
    expect(refreshMock).toHaveBeenCalledTimes(1);

    // Order: setup → subproject a → subproject b → root.
    const runOrder = calls.filter((c) => c.startsWith("runOne"));
    expect(runOrder).toEqual([
      `runOne:subproject:${path.join(repo, "packages/a")}`,
      `runOne:subproject:${path.join(repo, "packages/b")}`,
      `runOne:root:${repo}`,
    ]);

    // resolveRunModel and the refresh precede the first run.
    expect(calls.indexOf("resolveRunModel")).toBeLessThan(
      calls.findIndex((c) => c.startsWith("runOne")),
    );

    expect(result.subprojectResults).toHaveLength(2);
    expect(result.rootResult.model).toBe("test-model");
  });

  test("writes openwiki/workspaces.md BEFORE the root run", async () => {
    const repo = await createMonorepo();

    // Instrument runOne so we can observe the filesystem state at the root run.
    let workspacesMdExistedAtRootRun = false;
    runOneMock.mockImplementation(
      async (
        command: string,
        cwd: string,
        options: { recursionRole?: string },
      ) => {
        if (options.recursionRole === "root") {
          workspacesMdExistedAtRootRun = await readFile(
            path.join(repo, "openwiki", "workspaces.md"),
            "utf8",
          )
            .then(() => true)
            .catch(() => false);
        }
        return { command, model: "test-model" };
      },
    );

    await runRecursiveOpenWiki(
      "init",
      repo,
      { outputMode: "repository" },
      { version: 1, workspaces: [{ path: "packages/a" }] },
    );

    expect(workspacesMdExistedAtRootRun).toBe(true);
  });

  test("empty manifest falls back to a single plain run (no recursion role)", async () => {
    const repo = await createMonorepo();

    const result = await runRecursiveOpenWiki(
      "update",
      repo,
      { outputMode: "repository" },
      { version: 1, workspaces: [] },
    );

    const runOrder = calls.filter((c) => c.startsWith("runOne"));
    expect(runOrder).toEqual([`runOne:none:${repo}`]);
    expect(result.subprojectResults).toHaveLength(0);
  });

  test("skips a workspace with no documentable evidence", async () => {
    const repo = await createMonorepo();
    await mkdir(path.join(repo, "packages", "empty"), { recursive: true });

    const result = await runRecursiveOpenWiki(
      "init",
      repo,
      { outputMode: "repository" },
      {
        version: 1,
        workspaces: [{ path: "packages/a" }, { path: "packages/empty" }],
      },
    );

    const runOrder = calls.filter(
      (c) => c.startsWith("runOne") && c.includes("subproject"),
    );
    expect(runOrder).toEqual([
      `runOne:subproject:${path.join(repo, "packages/a")}`,
    ]);
    expect(result.skippedWorkspaces.map((w) => w.path)).toEqual([
      "packages/empty",
    ]);
  });

  test("continues past a failing subproject, still runs aggregation + root", async () => {
    const repo = await createMonorepo();

    // Fail the FIRST subproject (packages/a); packages/b and root must still run.
    runOneMock.mockImplementation(
      (
        command: string,
        cwd: string,
        options: { recursionRole?: string },
      ): Promise<{ command: string; model: string }> => {
        calls.push(`runOne:${options.recursionRole ?? "none"}:${cwd}`);
        if (cwd === path.join(repo, "packages/a")) {
          return Promise.reject(new Error("boom in a"));
        }
        return Promise.resolve({ command, model: "test-model" });
      },
    );

    const result = await runRecursiveOpenWiki(
      "init",
      repo,
      { outputMode: "repository" },
      {
        version: 1,
        workspaces: [{ path: "packages/a" }, { path: "packages/b" }],
      },
    );

    // The failure is collected, not thrown.
    expect(result.failedWorkspaces).toEqual([
      { path: "packages/a", error: "boom in a" },
    ]);
    // packages/b succeeded and the root still ran.
    expect(result.subprojectResults).toHaveLength(1);
    const runOrder = calls.filter((c) => c.startsWith("runOne"));
    expect(runOrder).toContain(
      `runOne:subproject:${path.join(repo, "packages/b")}`,
    );
    expect(runOrder).toContain(`runOne:root:${repo}`);

    // Aggregation was written and excludes the failed subproject.
    const workspacesMd = await readFile(
      path.join(repo, "openwiki", "workspaces.md"),
      "utf8",
    );
    expect(workspacesMd).toContain("packages/b/openwiki/quickstart.md");
    expect(workspacesMd).not.toContain("packages/a/openwiki/quickstart.md");
  });
});

describe("writeRootAggregation content", () => {
  test("aggregation links down to each subproject quickstart with OKF front matter", async () => {
    const repo = await createMonorepo();
    const { writeRootAggregation } =
      await import("../src/monorepo/orchestrator.ts");
    const plan = resolveWorkspaceRuns(repo, {
      version: 1,
      workspaces: [
        { path: "packages/a", name: "Alpha", goal: "the alpha pkg" },
        { path: "packages/b" },
      ],
    });

    await writeRootAggregation(repo, plan);

    const content = await readFile(
      path.join(repo, "openwiki", "workspaces.md"),
      "utf8",
    );
    expect(content).toMatch(/^---\ntype: Reference/);
    expect(content).toContain("[Alpha](../packages/a/openwiki/quickstart.md)");
    expect(content).toContain("the alpha pkg");
    expect(content).toContain(
      "[packages/b](../packages/b/openwiki/quickstart.md)",
    );
  });
});
