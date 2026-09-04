import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The orchestrator drives each run through runOpenWikiAgent and does its
 * once-up-front setup via loadOpenWikiEnv / syncBundledSkills /
 * ensureCodeModeRepoSetup. We mock all of those to record call order and counts
 * without touching a model. Model resolution now happens INSIDE runOpenWikiAgent
 * per run (cheap, no network), so there is no separate resolveRunModel/refresh
 * step to observe here.
 */
const calls: string[] = [];

const defaultRunImpl = (
  command: string,
  cwd: string,
  options: { recursionRole?: string },
): Promise<{ command: string; model: string }> => {
  calls.push(`run:${options.recursionRole ?? "none"}:${cwd}`);
  return Promise.resolve({ command, model: "test-model" });
};

const runAgentMock = vi.fn(defaultRunImpl);

vi.mock("../src/agent/index.ts", () => ({
  runOpenWikiAgent: runAgentMock,
}));

const loadEnvMock = vi.fn((): Promise<void> => {
  calls.push("loadOpenWikiEnv");
  return Promise.resolve();
});
vi.mock("../src/config/env.ts", () => ({
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
vi.mock("../src/ingestion/code-mode.ts", () => ({
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
  runAgentMock.mockImplementation(defaultRunImpl);
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

    // Order: setup → subproject a → subproject b → root.
    const runOrder = calls.filter((c) => c.startsWith("run:"));
    expect(runOrder).toEqual([
      `run:subproject:${path.join(repo, "packages/a")}`,
      `run:subproject:${path.join(repo, "packages/b")}`,
      `run:root:${repo}`,
    ]);

    // Shared setup precedes the first run.
    expect(calls.indexOf("ensureCodeModeRepoSetup")).toBeLessThan(
      calls.findIndex((c) => c.startsWith("run:")),
    );

    expect(result.subprojectResults).toHaveLength(2);
    expect(result.rootResult.model).toBe("test-model");
  });

  test("writes openwiki/workspaces.md BEFORE the root run", async () => {
    const repo = await createMonorepo();

    // Instrument the run so we can observe the filesystem state at the root run.
    let workspacesMdExistedAtRootRun = false;
    runAgentMock.mockImplementation(
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

    const runOrder = calls.filter((c) => c.startsWith("run:"));
    expect(runOrder).toEqual([`run:none:${repo}`]);
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
      (c) => c.startsWith("run:") && c.includes("subproject"),
    );
    expect(runOrder).toEqual([
      `run:subproject:${path.join(repo, "packages/a")}`,
    ]);
    expect(result.skippedWorkspaces.map((w) => w.path)).toEqual([
      "packages/empty",
    ]);
  });

  test("continues past a failing subproject, still runs aggregation + root", async () => {
    const repo = await createMonorepo();

    // Fail the FIRST subproject (packages/a); packages/b and root must still run.
    runAgentMock.mockImplementation(
      (
        command: string,
        cwd: string,
        options: { recursionRole?: string },
      ): Promise<{ command: string; model: string }> => {
        calls.push(`run:${options.recursionRole ?? "none"}:${cwd}`);
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
    const runOrder = calls.filter((c) => c.startsWith("run:"));
    expect(runOrder).toContain(
      `run:subproject:${path.join(repo, "packages/b")}`,
    );
    expect(runOrder).toContain(`run:root:${repo}`);

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

  /**
   * Writes a subproject's generated openwiki/quickstart.md with the given
   * front-matter description (or none) so aggregation can distill it.
   */
  async function writeSubprojectQuickstart(
    repo: string,
    relativePath: string,
    description?: string,
  ): Promise<void> {
    await mkdir(path.join(repo, relativePath, "openwiki"), { recursive: true });
    const frontmatter = [
      "---",
      "type: Reference",
      "title: Quickstart",
      ...(description === undefined ? [] : [`description: ${description}`]),
      "---",
      "",
      "# Quickstart",
      "",
    ].join("\n");
    await writeFile(
      path.join(repo, relativePath, "openwiki", "quickstart.md"),
      frontmatter,
      "utf8",
    );
  }

  test("prefers each subproject's distilled quickstart description over the manifest goal", async () => {
    const repo = await createMonorepo();
    const { writeRootAggregation } =
      await import("../src/monorepo/orchestrator.ts");
    // packages/a produced a quickstart whose description should WIN over goal.
    await writeSubprojectQuickstart(
      repo,
      "packages/a",
      "Distilled alpha overview.",
    );

    const plan = resolveWorkspaceRuns(repo, {
      version: 1,
      workspaces: [{ path: "packages/a", name: "Alpha", goal: "input brief" }],
    });
    await writeRootAggregation(repo, plan);

    const content = await readFile(
      path.join(repo, "openwiki", "workspaces.md"),
      "utf8",
    );
    expect(content).toContain(
      "[Alpha](../packages/a/openwiki/quickstart.md) — Distilled alpha overview.",
    );
    // The input manifest brief must NOT appear once a distilled description exists.
    expect(content).not.toContain("input brief");
  });

  test("falls back to the manifest goal when the quickstart has no description", async () => {
    const repo = await createMonorepo();
    const { writeRootAggregation } =
      await import("../src/monorepo/orchestrator.ts");
    // Quickstart exists but has no description front-matter field.
    await writeSubprojectQuickstart(repo, "packages/a", undefined);

    const plan = resolveWorkspaceRuns(repo, {
      version: 1,
      workspaces: [{ path: "packages/a", name: "Alpha", goal: "the alpha pkg" }],
    });
    await writeRootAggregation(repo, plan);

    const content = await readFile(
      path.join(repo, "openwiki", "workspaces.md"),
      "utf8",
    );
    expect(content).toContain(
      "[Alpha](../packages/a/openwiki/quickstart.md) — the alpha pkg",
    );
  });

  test("omits the summary and does not throw when neither description nor goal exists", async () => {
    const repo = await createMonorepo();
    const { writeRootAggregation } =
      await import("../src/monorepo/orchestrator.ts");
    // No quickstart file at all for packages/a, and no manifest goal.
    const plan = resolveWorkspaceRuns(repo, {
      version: 1,
      workspaces: [{ path: "packages/a", name: "Alpha" }],
    });

    await expect(writeRootAggregation(repo, plan)).resolves.toBeUndefined();

    const content = await readFile(
      path.join(repo, "openwiki", "workspaces.md"),
      "utf8",
    );
    // The link row is present with NO summary suffix.
    expect(content).toContain("[Alpha](../packages/a/openwiki/quickstart.md)\n");
    expect(content).not.toContain("[Alpha](../packages/a/openwiki/quickstart.md) —");
  });
});

describe("runRecursiveOpenWiki changed-subproject planning context", () => {
  test("passes updated vs unchanged subprojects to the root run's planning context", async () => {
    const repo = await createMonorepo();

    // packages/a regenerated (skipped falsy); packages/b internally no-op'd
    // (skipped: true). The root run must be told which is which.
    let rootUserMessage: string | undefined;
    runAgentMock.mockImplementation(
      (
        command: string,
        cwd: string,
        options: { recursionRole?: string; userMessage?: string | null },
      ): Promise<{ command: string; model: string; skipped?: boolean }> => {
        if (options.recursionRole === "root") {
          rootUserMessage = options.userMessage ?? undefined;
          return Promise.resolve({ command, model: "test-model" });
        }
        const skipped = cwd === path.join(repo, "packages/b");
        return Promise.resolve({ command, model: "test-model", skipped });
      },
    );

    await runRecursiveOpenWiki(
      "update",
      repo,
      { outputMode: "repository" },
      {
        version: 1,
        workspaces: [{ path: "packages/a" }, { path: "packages/b" }],
      },
    );

    expect(rootUserMessage).toBeDefined();
    expect(rootUserMessage).toContain(
      "Subprojects updated in this run: packages/a.",
    );
    // The internally-skipped subproject is classified UNCHANGED.
    expect(rootUserMessage).toMatch(
      /Subprojects unchanged in this run \([^)]*\): packages\/b\./,
    );
  });

  test("merges the changed-subproject note with a caller-supplied userMessage", async () => {
    const repo = await createMonorepo();

    let rootUserMessage: string | undefined;
    runAgentMock.mockImplementation(
      (
        command: string,
        cwd: string,
        options: { recursionRole?: string; userMessage?: string | null },
      ): Promise<{ command: string; model: string }> => {
        if (options.recursionRole === "root") {
          rootUserMessage = options.userMessage ?? undefined;
        }
        return Promise.resolve({ command, model: "test-model" });
      },
    );

    await runRecursiveOpenWiki(
      "init",
      repo,
      { outputMode: "repository", userMessage: "Focus on operator safety." },
      { version: 1, workspaces: [{ path: "packages/a" }] },
    );

    expect(rootUserMessage).toContain("Focus on operator safety.");
    expect(rootUserMessage).toContain(
      "Subprojects updated in this run: packages/a.",
    );
  });
});
