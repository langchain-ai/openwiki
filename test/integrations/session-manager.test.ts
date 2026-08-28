import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type {
  ActiveBeginView,
  NextRepositoryPageResult,
} from "../../src/generation/repository-run.ts";
import { HostSessionManager } from "../../src/integrations/core/session-manager.ts";

const RUN_TIMESTAMP = "2026-08-24T12:00:00.000Z";
const temporaryRoots: string[] = [];

/**
 * Creates an isolated Git repository containing one evidence file.
 *
 * @returns Absolute temporary repository root.
 */
async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-session-"));
  temporaryRoots.push(root);
  execFileSync("git", ["init", "--quiet", root]);
  await writeFile(path.join(root, "README.md"), "# Repository\n", "utf8");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=OpenWiki Test",
    "-c",
    "user.email=openwiki@example.test",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  return root;
}

/**
 * Creates a host manager with a deterministic lifecycle clock.
 *
 * @param host - Stable host identity for the manager.
 * @returns Validated empty host manager.
 */
function createManager(host = "codex"): HostSessionManager {
  return HostSessionManager.create({
    host,
    now: () => new Date(RUN_TIMESTAMP),
  });
}

/**
 * Renders a valid factual page for lifecycle smoke tests.
 *
 * @returns Complete OKF Markdown page.
 */
function quickstartPage(): string {
  return [
    "---",
    "type: Guide",
    "title: Quickstart",
    "description: Repository quickstart.",
    "---",
    "",
    "# Quickstart",
    "",
    "The repository is introduced by its README.",
    "",
  ].join("\n");
}

/**
 * Begins an init run and installs its required one-page plan.
 *
 * @param manager - Host manager that owns the run.
 * @param root - Absolute temporary repository root.
 * @returns Active begin view and first pending job.
 */
async function beginPlannedInit(
  manager: HostSessionManager,
  root: string,
): Promise<{ view: ActiveBeginView; page: NextRepositoryPageResult }> {
  const view = (await manager.begin({ root, mode: "init" })) as ActiveBeginView;
  await manager.submitPlan({
    runId: view.runId,
    pages: [
      {
        path: "/openwiki/quickstart.md",
        title: "Quickstart",
        purpose: "Orient repository readers.",
        seedPaths: ["README.md"],
      },
    ],
  });
  const page = (await manager.nextPage({
    runId: view.runId,
  })) as NextRepositoryPageResult;
  return { view, page };
}

/**
 * Completes and finishes the planned one-page init fixture.
 *
 * @param manager - Host manager that owns the run.
 * @param root - Absolute temporary repository root.
 * @param view - Active run view returned by begin.
 * @param page - Pending page result returned by next-page.
 */
async function completePlannedInit(
  manager: HostSessionManager,
  root: string,
  view: ActiveBeginView,
  page: NextRepositoryPageResult,
): Promise<void> {
  if (page.status !== "pending") {
    throw new Error("Expected the init fixture to contain a pending page.");
  }
  await writeFile(
    path.join(root, "openwiki/quickstart.md"),
    quickstartPage(),
    "utf8",
  );
  await manager.submitPage({
    runId: view.runId,
    jobId: page.job.id,
    claims: [
      {
        statement: "The repository is introduced by its README.",
        evidence: [{ resource: "repo://README.md" }],
      },
    ],
  });
  await expect(manager.nextPage({ runId: view.runId })).resolves.toEqual({
    status: "complete",
  });
  await expect(manager.finish({ runId: view.runId })).resolves.toEqual({
    status: "complete",
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("HostSessionManager", () => {
  test("resumes one durable queue across different hosts", async () => {
    const root = await createRepository();
    const codex = createManager("codex");
    const started = (await codex.begin({
      root,
      mode: "init",
    })) as ActiveBeginView;
    await codex.submitPlan({
      runId: started.runId,
      pages: [
        {
          path: "/openwiki/architecture.md",
          title: "Architecture",
          purpose: "Document the repository architecture.",
          seedPaths: ["README.md"],
        },
        {
          path: "/openwiki/quickstart.md",
          title: "Quickstart",
          purpose: "Orient repository readers.",
          seedPaths: ["README.md"],
        },
      ],
    });
    const first = (await codex.nextPage({
      runId: started.runId,
    })) as NextRepositoryPageResult;
    if (first.status !== "pending") throw new Error("Expected first page.");
    await writeFile(
      path.join(root, "openwiki/architecture.md"),
      quickstartPage().replaceAll("Quickstart", "Architecture"),
      "utf8",
    );
    await codex.submitPage({
      runId: started.runId,
      jobId: first.job.id,
      claims: [
        {
          statement: "The repository is introduced by its README.",
          evidence: [{ resource: "repo://README.md" }],
        },
      ],
    });

    const claude = createManager("claude-code");
    const resumed = (await claude.begin({
      root,
      mode: "init",
    })) as ActiveBeginView;
    expect(resumed).toMatchObject({
      runId: started.runId,
      resumed: true,
      completedPages: 1,
      totalPages: 2,
    });
    await expect(
      claude.nextPage({ runId: resumed.runId }),
    ).resolves.toMatchObject({
      status: "pending",
      job: { path: "/openwiki/quickstart.md" },
    });
  });

  test("exposes exactly the ordered five-call lifecycle", () => {
    expect(
      createManager()
        .tools()
        .map(({ name }) => name),
    ).toEqual([
      "openwiki_begin",
      "openwiki_submit_plan",
      "openwiki_next_page",
      "openwiki_submit_page",
      "openwiki_finish",
    ]);
  });

  test("validates host and producer identities", () => {
    expect(() => HostSessionManager.create({ host: "Codex Agent" })).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
    expect(() =>
      HostSessionManager.create({
        host: "codex",
        producerActor: "Claude Code",
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  test("resolves a nested path to the canonical Git root", async () => {
    const root = await createRepository();
    const nested = path.join(root, "src/nested");
    await mkdir(nested, { recursive: true });

    const view = (await createManager().begin({
      root: nested,
      mode: "init",
    })) as ActiveBeginView;

    expect(view.root).toBe(await realpath(root));
    expect(view.phase).toBe("planning");
  });

  test("requires the exact active run ID", async () => {
    const root = await createRepository();
    const manager = createManager();
    const view = (await manager.begin({
      root,
      mode: "init",
    })) as ActiveBeginView;

    await expect(
      manager.nextPage({ runId: "123e4567-e89b-42d3-a456-426614174000" }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    await expect(manager.nextPage({ runId: view.runId })).rejects.toMatchObject(
      { code: "invalid_state" },
    );
  });

  test("maps begin conflicts and retains the prior active run", async () => {
    const root = await createRepository();
    const manager = createManager();
    const view = (await manager.begin({
      root,
      mode: "init",
    })) as ActiveBeginView;

    await expect(manager.begin({ root, mode: "update" })).rejects.toMatchObject(
      {
        name: "HostIntegrationError",
        code: "conflict",
      },
    );
    await expect(manager.nextPage({ runId: view.runId })).rejects.toMatchObject(
      { code: "invalid_state" },
    );
  });

  test("rejects overlapping lifecycle operations and releases the guard", async () => {
    const root = await createRepository();
    const manager = createManager();
    const first = manager.begin({ root, mode: "init" });

    await expect(manager.begin({ root, mode: "update" })).rejects.toMatchObject(
      {
        code: "invalid_state",
        message: "Another OpenWiki lifecycle operation is already in progress.",
      },
    );
    const view = (await first) as ActiveBeginView;
    await expect(manager.nextPage({ runId: view.runId })).rejects.toMatchObject(
      { code: "invalid_state" },
    );
  });

  test("maps repository lifecycle failures to bounded host errors", async () => {
    const root = await createRepository();
    const manager = createManager();
    const { view } = await beginPlannedInit(manager, root);

    await expect(
      manager.submitPage({
        runId: view.runId,
        jobId: "123e4567-e89b-42d3-a456-426614174000",
        claims: [
          {
            statement: "The repository has a README.",
            evidence: [{ resource: "repo://README.md" }],
          },
        ],
      }),
    ).rejects.toMatchObject({
      name: "HostIntegrationError",
      code: "invalid_input",
      message: "Unknown OpenWiki page job.",
    });
  });

  test("retains active state after finish fails", async () => {
    const root = await createRepository();
    const manager = createManager();
    const { view, page } = await beginPlannedInit(manager, root);

    await expect(manager.finish({ runId: view.runId })).rejects.toMatchObject({
      code: "invalid_state",
    });
    await expect(manager.nextPage({ runId: view.runId })).resolves.toEqual(
      page,
    );
  });

  test("clears active state only after successful durable finish", async () => {
    const root = await createRepository();
    const manager = createManager();
    const { view, page } = await beginPlannedInit(manager, root);

    await completePlannedInit(manager, root, view, page);

    await expect(manager.nextPage({ runId: view.runId })).rejects.toMatchObject(
      {
        code: "invalid_state",
      },
    );
  });

  test("clears an older process-local run after a proven update no-op", async () => {
    const completeRoot = await createRepository();
    const initializer = createManager();
    const initialized = await beginPlannedInit(initializer, completeRoot);
    await completePlannedInit(
      initializer,
      completeRoot,
      initialized.view,
      initialized.page,
    );
    execFileSync("git", ["-C", completeRoot, "add", "--all"]);
    execFileSync("git", [
      "-C",
      completeRoot,
      "-c",
      "user.name=OpenWiki Test",
      "-c",
      "user.email=openwiki@example.test",
      "commit",
      "--quiet",
      "-m",
      "generated wiki",
    ]);
    const settler = createManager();
    const settling = (await settler.begin({
      root: completeRoot,
      mode: "update",
      force: true,
    })) as ActiveBeginView;
    await settler.submitPlan({ runId: settling.runId, pages: [] });
    await settler.finish({ runId: settling.runId });

    const activeRoot = await createRepository();
    const manager = createManager();
    const active = (await manager.begin({
      root: activeRoot,
      mode: "init",
    })) as ActiveBeginView;
    const noop = await manager.begin({ root: completeRoot, mode: "update" });

    expect(noop).toMatchObject({ status: "noop", mode: "update" });
    await expect(
      manager.nextPage({ runId: active.runId }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });
});
