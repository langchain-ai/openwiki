import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const failureHarness = vi.hoisted(() => ({
  metadataWrites: 0,
  stateWrites: 0,
  stateRemovals: 0,
}));

vi.mock("../../src/agent/utils.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/agent/utils.js")>();
  return {
    ...actual,
    async writeLastUpdateMetadata(
      ...args: Parameters<typeof actual.writeLastUpdateMetadata>
    ) {
      if (failureHarness.metadataWrites > 0) {
        failureHarness.metadataWrites -= 1;
        throw new Error("injected metadata failure");
      }
      return actual.writeLastUpdateMetadata(...args);
    },
  };
});

vi.mock("../../src/generation/run-state.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/generation/run-state.js")>();
  return {
    ...actual,
    async writeRepositoryRunState(
      ...args: Parameters<typeof actual.writeRepositoryRunState>
    ) {
      if (failureHarness.stateWrites > 0) {
        failureHarness.stateWrites -= 1;
        throw new Error("injected run-state write failure");
      }
      return actual.writeRepositoryRunState(...args);
    },
    async removeRepositoryRunState(
      ...args: Parameters<typeof actual.removeRepositoryRunState>
    ) {
      if (failureHarness.stateRemovals > 0) {
        failureHarness.stateRemovals -= 1;
        throw new Error("injected run-state removal failure");
      }
      return actual.removeRepositoryRunState(...args);
    },
  };
});

import { ensureCodeModeRepoSetup } from "../../src/ingestion/code-mode.ts";
import { ClaimsPersistenceError } from "../../src/claims/core/errors.ts";
import { ClaimsStore } from "../../src/claims/brains/code/store.ts";
import { parseFrontmatterFields } from "../../src/okf/frontmatter.ts";
import { OPENWIKI_PRODUCER_ACTOR } from "../../src/version.ts";
import {
  beginRepositoryRun,
  finishRepositoryRun,
  nextRepositoryPage,
  submitRepositoryPage,
  submitRepositoryPlan,
  type ActiveRepositoryRun,
  type BeginRepositoryRunResult,
} from "../../src/generation/repository-run.ts";
import {
  readRepositoryRunState,
  repositoryRunStatePath,
} from "../../src/generation/run-state.ts";

const execFileAsync = promisify(execFile);
const ACTOR = {
  producerActor: "host-agent/test",
  metadataModel: "test-model",
};
const STARTED_AT = "2026-08-24T12:00:00.000Z";
const temporaryDirectories: string[] = [];

/**
 * Runs one Git command in a temporary test repository.
 *
 * @param root - Absolute temporary repository root.
 * @param args - Git arguments excluding the executable name.
 * @returns Trimmed standard output.
 */
async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: root });
  return stdout.trim();
}

/**
 * Creates one valid factual OpenWiki Markdown page.
 *
 * @param title - Human-readable page title.
 * @returns Complete valid OKF Markdown.
 */
function validPage(title: string): string {
  return `---\ntype: Guide\ntitle: ${title}\n---\n\n# ${title}\n`;
}

/**
 * Writes one generated Markdown page below a repository's OpenWiki directory.
 *
 * @param root - Absolute temporary repository root.
 * @param page - Repository-relative path below `openwiki/`.
 * @param content - Complete page contents.
 */
async function writeWikiPage(
  root: string,
  page: string,
  content: string,
): Promise<void> {
  const target = path.join(root, "openwiki", page);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

/**
 * Creates a committed Git repository with stable code-mode setup and wiki.
 *
 * @param extraPages - Additional factual pages committed before the run.
 * @returns Absolute temporary repository root.
 */
async function createRepository(extraPages: string[] = []): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "openwiki-repository-run-"));
  temporaryDirectories.push(root);
  await git(root, ["init", "--quiet"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "OpenWiki Test"]);
  await writeFile(path.join(root, "README.md"), "# Repository\n", "utf8");
  await writeWikiPage(root, "quickstart.md", validPage("Quickstart"));
  for (const page of extraPages) {
    const title = path.basename(page, ".md");
    await writeWikiPage(root, page, validPage(title));
  }
  await ensureCodeModeRepoSetup(root);
  await git(root, ["add", "."]);
  await git(root, ["commit", "--quiet", "-m", "initial"]);
  const head = await git(root, ["rev-parse", "HEAD"]);
  await writeFile(
    path.join(root, "openwiki", ".last-update.json"),
    `${JSON.stringify(
      {
        updatedAt: "2026-08-23T12:00:00.000Z",
        command: "update",
        gitHead: head,
        model: "previous-model",
        status: "complete",
        language: "en",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return root;
}

/**
 * Narrows a begin result to an active repository run.
 *
 * @param result - Begin result that must require semantic work.
 * @returns Active process-local repository run.
 */
function requireActiveRun(
  result: BeginRepositoryRunResult,
): ActiveRepositoryRun {
  if (!("run" in result)) {
    throw new Error("Expected an active repository run.");
  }
  return result.run;
}

/**
 * Starts one forced update with deterministic identity and time.
 *
 * @param root - Absolute temporary repository root.
 * @param planningContext - Optional real host/user planning context.
 * @returns Active update run.
 */
async function beginForcedUpdate(
  root: string,
  planningContext?: string,
): Promise<ActiveRepositoryRun> {
  return requireActiveRun(
    await beginRepositoryRun({
      root,
      mode: "update",
      force: true,
      ...(planningContext ? { planningContext } : {}),
      actor: ACTOR,
      now: () => new Date(STARTED_AT),
    }),
  );
}

/**
 * Writes and durably submits the first job in an active run.
 *
 * @param run - Active run with a persisted one-page plan.
 * @param title - Final page title.
 */
async function completeCurrentPage(
  run: ActiveRepositoryRun,
  title: string,
): Promise<void> {
  const next = await nextRepositoryPage(run);
  if (next.status !== "pending") {
    throw new Error("Expected a pending page job.");
  }
  const write = await run.backend.write(next.job.path, validPage(title));
  if (write.error) throw new Error(write.error);
  await submitRepositoryPage(run, {
    jobId: next.job.id,
    claims: [
      {
        statement: "The repository has a README.",
        evidence: [{ resource: "repo://README.md" }],
      },
    ],
  });
}

beforeEach(() => {
  failureHarness.metadataWrites = 0;
  failureHarness.stateWrites = 0;
  failureHarness.stateRemovals = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("beginRepositoryRun", () => {
  test("rolls back fresh init and removes new run state after metadata failure", async () => {
    const root = await createRepository(["old.md"]);
    const oldContent = await readFile(
      path.join(root, "openwiki", "old.md"),
      "utf8",
    );
    failureHarness.metadataWrites = 1;

    await expect(
      beginRepositoryRun({
        root,
        mode: "init",
        actor: ACTOR,
        now: () => new Date(STARTED_AT),
      }),
    ).rejects.toThrow("injected metadata failure");

    await expect(
      readFile(path.join(root, "openwiki", "old.md"), "utf8"),
    ).resolves.toBe(oldContent);
    await expect(readRepositoryRunState(root)).resolves.toBeNull();
    await expect(
      readFile(repositoryRunStatePath(root), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("returns a strict no-op only for clean updates without Claim issues", async () => {
    const root = await createRepository();

    const result = await beginRepositoryRun({
      root,
      mode: "update",
      actor: ACTOR,
      now: () => new Date(STARTED_AT),
    });

    expect(result).not.toHaveProperty("run");
    expect(result.view).toMatchObject({
      status: "noop",
      mode: "update",
      language: "en",
      updatePreflight: { shouldSkip: true },
    });
    expect(await readRepositoryRunState(root)).toBeNull();
    await expect(
      readFile(repositoryRunStatePath(root), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("Claims preflight prevents a Git-clean update from skipping", async () => {
    const root = await createRepository();
    const store = new ClaimsStore(root);
    await store.writePage("/openwiki/quickstart.md", {
      schemaVersion: 1,
      pageVersion: await store.hashPage("/openwiki/quickstart.md"),
      claims: [
        {
          id: "claim_stale",
          statement: "The repository has a README.",
          evidence: [
            {
              resource: "repo://README.md",
              version: "repo-file-v1:sha256:outdated",
            },
          ],
        },
      ],
    });

    const result = await beginRepositoryRun({
      root,
      mode: "update",
      actor: ACTOR,
      now: () => new Date(STARTED_AT),
    });
    const run = requireActiveRun(result);

    expect(result.view).toMatchObject({
      status: "active",
      claimIssues: [
        {
          page: "/openwiki/quickstart.md",
          kind: "stale",
          claimId: "claim_stale",
        },
      ],
    });
    expect(run.state.plan).toBeUndefined();
    await expect(readRepositoryRunState(root)).resolves.toMatchObject({
      phase: "planning",
    });

    await expect(submitRepositoryPlan(run, { pages: [] })).resolves.toEqual({
      status: "accepted",
      totalPages: 1,
    });
    expect(run.state.plan?.pages).toEqual([
      expect.objectContaining({
        path: "/openwiki/quickstart.md",
        seedPaths: ["README.md"],
        status: "pending",
      }),
    ]);
  });

  test("resumes the same owner while rejecting mode, language, and producer conflicts", async () => {
    const root = await createRepository();
    const initial = await beginForcedUpdate(root, "Original context");

    await expect(
      beginRepositoryRun({ root, mode: "init", actor: ACTOR }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      beginRepositoryRun({
        root,
        mode: "update",
        language: "fr",
        actor: ACTOR,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      beginRepositoryRun({
        root,
        mode: "update",
        actor: { ...ACTOR, producerActor: "host-agent/other" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    const resumedResult = await beginRepositoryRun({
      root,
      mode: "update",
      planningContext: "Replacement context",
      actor: { ...ACTOR, metadataModel: "replacement-model" },
    });
    const resumed = requireActiveRun(resumedResult);
    expect(resumedResult.view).toMatchObject({
      status: "active",
      resumed: true,
      runId: initial.state.runId,
    });
    expect(resumed.state.actor.metadataModel).toBe("replacement-model");
    expect(resumed.state.planningContext).toBe("Replacement context");
  });
});

describe("repository page queue", () => {
  test("keeps in-memory state unchanged until plan persistence succeeds", async () => {
    const root = await createRepository();
    const run = await beginForcedUpdate(root);
    const originalState = run.state;
    failureHarness.stateWrites = 1;

    await expect(
      submitRepositoryPlan(run, {
        pages: [
          {
            path: "/openwiki/quickstart.md",
            title: "Quickstart",
            purpose: "Refresh the entry point.",
          },
        ],
      }),
    ).rejects.toThrow("injected run-state write failure");

    expect(run.state).toBe(originalState);
    expect((await readRepositoryRunState(root))?.plan).toBeUndefined();

    await expect(
      submitRepositoryPlan(run, {
        pages: [
          {
            path: "/openwiki/quickstart.md",
            title: "Quickstart",
            purpose: "Refresh the entry point.",
          },
        ],
      }),
    ).resolves.toEqual({ status: "accepted", totalPages: 1 });
    expect(run.state.plan?.pages[0]?.status).toBe("pending");

    await expect(
      submitRepositoryPlan(run, {
        pages: [
          {
            path: "/openwiki/quickstart.md",
            title: "Quickstart",
            purpose: "Refresh the entry point.",
          },
        ],
      }),
    ).resolves.toEqual({ status: "accepted", totalPages: 1 });
    await expect(
      submitRepositoryPlan(run, {
        pages: [
          {
            path: "/openwiki/quickstart.md",
            title: "Quickstart",
            purpose: "A different semantic plan.",
          },
        ],
      }),
    ).rejects.toThrow("already has a different persisted plan");
  });

  test("does not complete a page until Claims and checkpoint state are durable", async () => {
    const root = await createRepository();
    const run = await beginForcedUpdate(root);
    await submitRepositoryPlan(run, {
      pages: [
        {
          path: "/openwiki/quickstart.md",
          title: "Quickstart",
          purpose: "Refresh the entry point.",
        },
      ],
    });
    const next = await nextRepositoryPage(run);
    if (next.status !== "pending") throw new Error("Expected pending job.");
    await run.backend.write(next.job.path, validPage("Quickstart"));
    vi.spyOn(ClaimsStore.prototype, "writePage").mockRejectedValueOnce(
      new ClaimsPersistenceError("disk unavailable"),
    );

    await expect(
      submitRepositoryPage(run, {
        jobId: next.job.id,
        claims: [
          {
            statement: "The repository has a README.",
            evidence: [{ resource: "repo://README.md" }],
          },
        ],
      }),
    ).rejects.toThrow("disk unavailable");
    expect(run.state.plan?.pages[0]?.status).toBe("pending");
    expect((await readRepositoryRunState(root))?.plan?.pages[0]?.status).toBe(
      "pending",
    );

    await expect(
      submitRepositoryPage(run, {
        jobId: next.job.id,
        claims: [
          {
            statement: "The repository has a README.",
            evidence: [{ resource: "repo://README.md" }],
          },
        ],
      }),
    ).resolves.toEqual({
      status: "complete",
      page: "/openwiki/quickstart.md",
      remaining: 0,
    });

    await expect(
      submitRepositoryPage(run, { jobId: next.job.id, claims: [] }),
    ).resolves.toMatchObject({ status: "complete", remaining: 0 });
  });

  test("keeps a durably claimed page pending when completion checkpointing fails", async () => {
    const root = await createRepository();
    const run = await beginForcedUpdate(root);
    await submitRepositoryPlan(run, {
      pages: [
        {
          path: "/openwiki/quickstart.md",
          title: "Quickstart",
          purpose: "Refresh the entry point.",
        },
      ],
    });
    const next = await nextRepositoryPage(run);
    if (next.status !== "pending") throw new Error("Expected pending job.");
    await run.backend.write(next.job.path, validPage("Quickstart"));
    const claims = [
      {
        statement: "The repository has a README.",
        evidence: [{ resource: "repo://README.md" }],
      },
    ];
    failureHarness.stateWrites = 1;

    await expect(
      submitRepositoryPage(run, { jobId: next.job.id, claims }),
    ).rejects.toThrow("injected run-state write failure");
    expect(run.state.plan?.pages[0]?.status).toBe("pending");
    expect((await readRepositoryRunState(root))?.plan?.pages[0]?.status).toBe(
      "pending",
    );
    await expect(
      new ClaimsStore(root).loadPage("/openwiki/quickstart.md"),
    ).resolves.toMatchObject({
      claims: [expect.objectContaining({ statement: claims[0].statement })],
    });

    await expect(
      submitRepositoryPage(run, { jobId: next.job.id, claims }),
    ).resolves.toMatchObject({ status: "complete", remaining: 0 });
  });

  test("rejects out-of-order submission and invalid final frontmatter", async () => {
    const root = await createRepository(["second.md"]);
    const run = await beginForcedUpdate(root);
    await submitRepositoryPlan(run, {
      pages: [
        {
          path: "/openwiki/quickstart.md",
          title: "Quickstart",
          purpose: "Refresh quickstart.",
        },
        {
          path: "/openwiki/second.md",
          title: "Second",
          purpose: "Refresh the second page.",
        },
      ],
    });
    const jobs = run.state.plan?.pages ?? [];

    await expect(
      submitRepositoryPage(run, { jobId: jobs[1].id, claims: [] }),
    ).rejects.toThrow("Only the current pending");

    await run.backend.write(jobs[0].path, "# Missing frontmatter\n");
    await expect(
      submitRepositoryPage(run, { jobId: jobs[0].id, claims: [] }),
    ).rejects.toThrow("Fix invalid front matter");
    expect(run.state.plan?.pages[0]?.status).toBe("pending");
  });
});

describe("finishRepositoryRun", () => {
  test("completes init with final Claims, sources, versions, and metadata durable", async () => {
    const root = await createRepository(["old.md"]);
    const result = await beginRepositoryRun({
      root,
      mode: "init",
      planningContext: "Document the public repository entry point.",
      actor: ACTOR,
      now: () => new Date(STARTED_AT),
    });
    const run = requireActiveRun(result);
    expect(run.state.initialPages).toEqual([]);
    await submitRepositoryPlan(run, {
      pages: [
        {
          path: "/openwiki/quickstart.md",
          title: "Quickstart",
          purpose: "Document the repository entry point.",
          instructions: ["Preserve the public context."],
        },
      ],
    });
    await completeCurrentPage(run, "Quickstart");

    await expect(finishRepositoryRun(run)).resolves.toEqual({
      status: "complete",
    });

    expect(await readRepositoryRunState(root)).toBeNull();
    await expect(
      readFile(path.join(root, "openwiki", "old.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const store = new ClaimsStore(root);
    const sidecar = await store.loadPage("/openwiki/quickstart.md");
    expect(sidecar?.pageVersion).toBe(
      await store.hashPage("/openwiki/quickstart.md"),
    );
    expect(sidecar?.verification).toEqual({
      by: OPENWIKI_PRODUCER_ACTOR,
      at: STARTED_AT,
    });
    const fields = parseFrontmatterFields(
      await readFile(path.join(root, "openwiki", "quickstart.md"), "utf8"),
    );
    expect(fields?.verified).toContainEqual({
      by: OPENWIKI_PRODUCER_ACTOR,
      at: STARTED_AT,
    });
    expect(fields?.generated).toEqual({
      by: ACTOR.producerActor,
      at: STARTED_AT,
    });
    expect(fields?.sources).toEqual([
      expect.objectContaining({ resource: "repo://README.md" }),
    ]);
    await expect(
      readFile(path.join(root, "openwiki", ".last-update.json"), "utf8").then(
        JSON.parse,
      ),
    ).resolves.toMatchObject({ status: "complete", model: "test-model" });
  });

  test("invalidates the whole plan on drift and removes only abandoned new pages", async () => {
    const root = await createRepository(["pre-existing.md"]);
    const runA = await beginForcedUpdate(root, "Plan A context");
    await submitRepositoryPlan(runA, {
      pages: [
        {
          path: "/openwiki/new-page.md",
          title: "New Page",
          purpose: "Document new work.",
        },
      ],
    });
    await runA.backend.write("/openwiki/new-page.md", validPage("New Page"));
    await writeFile(
      path.join(root, "README.md"),
      "# Repository\nSource changed.\n",
      "utf8",
    );

    await expect(finishRepositoryRun(runA)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(runA.state.phase).toBe("planning");
    expect(runA.state.plan).toBeUndefined();
    expect((await readRepositoryRunState(root))?.plan).toBeUndefined();

    const resumedResult = await beginRepositoryRun({
      root,
      mode: "update",
      planningContext: "Plan B context",
      actor: ACTOR,
    });
    const runB = requireActiveRun(resumedResult);
    expect(runB.state.runId).toBe(runA.state.runId);
    expect(runB.state.planningContext).toBe("Plan B context");
    await submitRepositoryPlan(runB, { pages: [] });
    await finishRepositoryRun(runB);

    await expect(
      readFile(path.join(root, "openwiki", "new-page.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(path.join(root, "openwiki", "pre-existing.md"), "utf8"),
    ).resolves.toContain("# pre-existing");
  });

  test("does not mutate active state when durable drift invalidation fails", async () => {
    const root = await createRepository();
    const run = await beginForcedUpdate(root);
    await submitRepositoryPlan(run, { pages: [] });
    const originalState = run.state;
    await writeFile(
      path.join(root, "README.md"),
      "# Repository\nSource changed.\n",
      "utf8",
    );
    failureHarness.stateWrites = 1;

    await expect(finishRepositoryRun(run)).rejects.toThrow(
      "injected run-state write failure",
    );
    expect(run.state).toBe(originalState);
    expect((await readRepositoryRunState(root))?.plan).toBeDefined();

    await expect(finishRepositoryRun(run)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(run.state.phase).toBe("planning");
    expect(run.state.plan).toBeUndefined();
  });

  test("rechecks source after deterministic finalization before completion", async () => {
    const root = await createRepository();
    const run = await beginForcedUpdate(root);
    await submitRepositoryPlan(run, { pages: [] });
    const finalizeClaims = run.claimsRuntime.finalize.bind(run.claimsRuntime);
    vi.spyOn(run.claimsRuntime, "finalize").mockImplementation(async (at) => {
      await finalizeClaims(at);
      await writeFile(
        path.join(root, "README.md"),
        "# Repository\nChanged during finish.\n",
        "utf8",
      );
    });

    await expect(finishRepositoryRun(run)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(run.state.phase).toBe("planning");
    expect(run.state.plan).toBeUndefined();
    await expect(readRepositoryRunState(root)).resolves.toMatchObject({
      phase: "planning",
    });
    await expect(
      readFile(path.join(root, "openwiki", ".last-update.json"), "utf8").then(
        JSON.parse,
      ),
    ).resolves.toMatchObject({ status: "interrupted" });
  });

  test("applies explicit existing-page deletions with Claims cleanup", async () => {
    const root = await createRepository(["delete-me.md", "keep-me.md"]);
    const keptBefore = await readFile(
      path.join(root, "openwiki", "keep-me.md"),
      "utf8",
    );
    const store = new ClaimsStore(root);
    await store.writePage("/openwiki/delete-me.md", {
      schemaVersion: 1,
      pageVersion: await store.hashPage("/openwiki/delete-me.md"),
      claims: [],
    });
    const run = await beginForcedUpdate(root);
    await submitRepositoryPlan(run, {
      pages: [],
      deletePages: ["/openwiki/delete-me.md"],
    });

    await finishRepositoryRun(run);

    await expect(
      readFile(path.join(root, "openwiki", "delete-me.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.loadPage("/openwiki/delete-me.md")).resolves.toBeNull();
    await expect(
      readFile(path.join(root, "openwiki", "keep-me.md"), "utf8"),
    ).resolves.toBe(keptBefore);
  });

  test("leaves a fully finalized run resumable when final state removal fails", async () => {
    const root = await createRepository();
    const run = await beginForcedUpdate(root);
    await submitRepositoryPlan(run, {
      pages: [
        {
          path: "/openwiki/quickstart.md",
          title: "Quickstart",
          purpose: "Refresh quickstart.",
        },
      ],
    });
    await completeCurrentPage(run, "Quickstart");
    failureHarness.stateRemovals = 1;

    await expect(finishRepositoryRun(run)).rejects.toThrow(
      "injected run-state removal failure",
    );
    await expect(readRepositoryRunState(root)).resolves.not.toBeNull();

    const resumed = requireActiveRun(
      await beginRepositoryRun({ root, mode: "update", actor: ACTOR }),
    );
    expect(resumed.state.plan?.pages[0]?.status).toBe("complete");
    await expect(finishRepositoryRun(resumed)).resolves.toEqual({
      status: "complete",
    });
    expect(await readRepositoryRunState(root)).toBeNull();
  });
});

describe("update hardening", () => {
  test("creates a planned page for a new source file and completes it durably", async () => {
    const root = await createRepository();
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "src", "new-feature.ts"),
      "export const newFeature = true;\n",
      "utf8",
    );

    const result = await beginRepositoryRun({
      root,
      mode: "update",
      actor: ACTOR,
      now: () => new Date(STARTED_AT),
    });
    const run = requireActiveRun(result);
    expect(result.view).toMatchObject({
      status: "active",
      changedPaths: ["src/new-feature.ts"],
    });
    await submitRepositoryPlan(run, {
      pages: [
        {
          path: "/openwiki/new-feature.md",
          title: "New Feature",
          purpose: "Document the newly added feature source.",
          seedPaths: ["src/new-feature.ts"],
        },
      ],
    });
    const next = await nextRepositoryPage(run);
    if (next.status !== "pending") {
      throw new Error("Expected the new feature page job.");
    }
    expect(next.job).toMatchObject({
      path: "/openwiki/new-feature.md",
      existing: false,
      seedPaths: ["src/new-feature.ts"],
    });
    await run.backend.write(next.job.path, validPage("New Feature"));
    await submitRepositoryPage(run, {
      jobId: next.job.id,
      claims: [
        {
          statement: "The repository exports a new feature flag.",
          evidence: [{ resource: "repo://src/new-feature.ts" }],
        },
      ],
    });

    await expect(finishRepositoryRun(run)).resolves.toEqual({
      status: "complete",
    });
    await expect(
      readFile(path.join(root, "openwiki", "new-feature.md"), "utf8"),
    ).resolves.toContain("# New Feature");
    await expect(
      new ClaimsStore(root).loadPage("/openwiki/new-feature.md"),
    ).resolves.toMatchObject({
      claims: [
        expect.objectContaining({
          statement: "The repository exports a new feature flag.",
        }),
      ],
    });
  });

  test("queues the owning page when deleted source makes a Claim unresolved", async () => {
    const root = await createRepository();
    const store = new ClaimsStore(root);
    await store.writePage("/openwiki/quickstart.md", {
      schemaVersion: 1,
      pageVersion: await store.hashPage("/openwiki/quickstart.md"),
      claims: [
        {
          id: "claim_deleted_source",
          statement: "The repository has a README.",
          evidence: [
            {
              resource: "repo://README.md",
              version: "repo-file-v1:sha256:previous",
            },
          ],
        },
      ],
    });
    await rm(path.join(root, "README.md"));

    const result = await beginRepositoryRun({
      root,
      mode: "update",
      actor: ACTOR,
      now: () => new Date(STARTED_AT),
    });
    const run = requireActiveRun(result);
    expect(result.view).toMatchObject({
      changedPaths: ["README.md"],
      claimIssues: [
        {
          page: "/openwiki/quickstart.md",
          claimId: "claim_deleted_source",
          kind: "unresolved",
          resources: ["repo://README.md"],
        },
      ],
    });

    await expect(submitRepositoryPlan(run, { pages: [] })).resolves.toEqual({
      status: "accepted",
      totalPages: 1,
    });
    expect(run.state.plan?.pages).toEqual([
      expect.objectContaining({
        path: "/openwiki/quickstart.md",
        seedPaths: ["README.md"],
        status: "pending",
      }),
    ]);
  });

  test("adds every existing factual page to a language-change rewrite queue", async () => {
    const root = await createRepository(["architecture.md"]);

    const result = await beginRepositoryRun({
      root,
      mode: "update",
      language: "fr",
      actor: ACTOR,
      now: () => new Date(STARTED_AT),
    });
    const run = requireActiveRun(result);
    expect(result.view).toMatchObject({
      status: "active",
      language: "fr",
      languageChanged: true,
    });
    await expect(submitRepositoryPlan(run, { pages: [] })).resolves.toEqual({
      status: "accepted",
      totalPages: 2,
    });
    expect(run.state.plan?.pages.map(({ path: page }) => page)).toEqual([
      "/openwiki/architecture.md",
      "/openwiki/quickstart.md",
    ]);
    expect(
      run.state.plan?.pages.every(({ purpose }) =>
        purpose.includes("target language"),
      ),
    ).toBe(true);

    await completeCurrentPage(run, "Architecture");
    await completeCurrentPage(run, "Quickstart");
    await finishRepositoryRun(run);

    await expect(
      readFile(path.join(root, "openwiki", ".last-update.json"), "utf8").then(
        JSON.parse,
      ),
    ).resolves.toMatchObject({ status: "complete", language: "fr" });
  });

  test("leaves an unaffected page byte-for-byte unchanged", async () => {
    const root = await createRepository(["unaffected.md"]);
    const unaffectedPath = path.join(root, "openwiki", "unaffected.md");
    const before = await readFile(unaffectedPath, "utf8");
    await writeFile(
      path.join(root, "README.md"),
      "# Repository\n\nUpdated source context.\n",
      "utf8",
    );
    const result = await beginRepositoryRun({
      root,
      mode: "update",
      actor: ACTOR,
      now: () => new Date(STARTED_AT),
    });
    const run = requireActiveRun(result);
    expect(result.view).toMatchObject({ changedPaths: ["README.md"] });
    await submitRepositoryPlan(run, {
      pages: [
        {
          path: "/openwiki/quickstart.md",
          title: "Quickstart",
          purpose: "Refresh only the repository entry point.",
        },
      ],
    });
    await completeCurrentPage(run, "Quickstart");
    await finishRepositoryRun(run);

    await expect(readFile(unaffectedPath, "utf8")).resolves.toBe(before);
  });

  test("resumes an interrupted update from its first pending page", async () => {
    const root = await createRepository(["second.md"]);
    const initial = await beginForcedUpdate(root);
    await submitRepositoryPlan(initial, {
      pages: [
        {
          path: "/openwiki/quickstart.md",
          title: "Quickstart",
          purpose: "Refresh the repository entry point.",
        },
        {
          path: "/openwiki/second.md",
          title: "Second",
          purpose: "Refresh the secondary guide.",
        },
      ],
    });
    await completeCurrentPage(initial, "Second");
    const completedJobId = initial.state.plan?.pages[0]?.id;

    const resumedResult = await beginRepositoryRun({
      root,
      mode: "update",
      actor: ACTOR,
    });
    const resumed = requireActiveRun(resumedResult);
    expect(resumedResult.view).toMatchObject({
      status: "active",
      phase: "generating",
      resumed: true,
      completedPages: 1,
      totalPages: 2,
    });
    const next = await nextRepositoryPage(resumed);
    if (next.status !== "pending") {
      throw new Error("Expected the remaining quickstart job.");
    }
    expect(next.job).toMatchObject({
      path: "/openwiki/quickstart.md",
      status: "pending",
    });
    expect(next.job.id).not.toBe(completedJobId);

    await completeCurrentPage(resumed, "Quickstart");
    await expect(nextRepositoryPage(resumed)).resolves.toEqual({
      status: "complete",
    });
    await expect(finishRepositoryRun(resumed)).resolves.toEqual({
      status: "complete",
    });
  });
});
