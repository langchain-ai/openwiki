import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const failureHarness = vi.hoisted(() => ({
  manifestReplacements: 0,
  manifestWrites: 0,
  metadataWrites: 0,
  stateWrites: 0,
  stateRemovals: 0,
  sourceMutationsAfterManifestReplacement: 0,
}));

vi.mock("../../src/generation/page-manifest.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/generation/page-manifest.js")
    >();
  return {
    ...actual,
    async recordRepositoryPageCompletion(
      ...args: Parameters<typeof actual.recordRepositoryPageCompletion>
    ) {
      if (failureHarness.manifestWrites > 0) {
        failureHarness.manifestWrites -= 1;
        throw new Error("injected page-manifest write failure");
      }
      return actual.recordRepositoryPageCompletion(...args);
    },
    async replaceRepositoryPageManifest(
      ...args: Parameters<typeof actual.replaceRepositoryPageManifest>
    ) {
      if (failureHarness.manifestReplacements > 0) {
        failureHarness.manifestReplacements -= 1;
        throw new Error("injected page-manifest replacement failure");
      }
      const result = await actual.replaceRepositoryPageManifest(...args);
      if (failureHarness.sourceMutationsAfterManifestReplacement > 0) {
        failureHarness.sourceMutationsAfterManifestReplacement -= 1;
        await writeFile(
          path.join(args[0], "README.md"),
          "# Repository\n\nChanged during manifest replacement.\n",
          "utf8",
        );
      }
      return result;
    },
  };
});

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
import {
  parseFrontmatterFields,
  validateOkfFrontmatter,
} from "../../src/okf/frontmatter.ts";
import { OPENWIKI_PRODUCER_ACTOR } from "../../src/version.ts";
import {
  beginRepositoryRun,
  captureRepositoryPageSnapshot,
  finishRepositoryRun,
  nextRepositoryPage,
  skipRepositoryPage,
  submitRepositoryPage,
  submitRepositoryPlan,
  type ActiveRepositoryRun,
  type BeginRepositoryRunResult,
} from "../../src/generation/repository-run.ts";
import {
  readRepositoryPageManifest,
  writeRepositoryPageManifest,
} from "../../src/generation/page-manifest.ts";
import {
  readRepositoryRunState,
  repositoryRunStatePath,
} from "../../src/generation/run-state.ts";

const execFileAsync = promisify(execFile);
const ACTOR = {
  producerActor: "host-agent/test",
  metadataModel: "test-model",
};
const OTHER_ACTOR = {
  producerActor: "host-agent/other",
  metadataModel: "other-model",
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
  const baselineStore = new ClaimsStore(root);
  for (const page of await baselineStore.discoverPages()) {
    await baselineStore.writePage(page, {
      schemaVersion: 1,
      pageVersion: await baselineStore.hashPage(page),
      claims: [],
      verification: {
        by: "openwiki/test",
        at: "2026-08-23T12:00:00.000Z",
      },
    });
  }
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
 * @param terminalNewline - Whether the authored page includes a final newline.
 */
async function completeCurrentPage(
  run: ActiveRepositoryRun,
  title: string,
  terminalNewline = true,
): Promise<void> {
  const next = await nextRepositoryPage(run);
  if (next.status !== "pending") {
    throw new Error("Expected a pending page job.");
  }
  const content = validPage(title);
  const write = await run.backend.write(
    next.job.path,
    terminalNewline ? content : content.replace(/\n$/u, ""),
  );
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

test("restores the exact pending Markdown and Claims snapshot", async () => {
  const root = await createRepository(["testing.md"]);
  const page = "/openwiki/testing.md";
  const successfulMetadata = JSON.parse(
    await readFile(path.join(root, "openwiki/.last-update.json"), "utf8"),
  ) as { gitHead: string };
  await writeFile(
    path.join(root, "README.md"),
    "# Changed repository\n",
    "utf8",
  );
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "--quiet", "-m", "change source"]);
  const store = new ClaimsStore(root);
  const originalClaims = {
    schemaVersion: 1 as const,
    pageVersion: await store.hashPage(page),
    claims: [],
  };
  await store.writePage(page, originalClaims);

  const run = await beginForcedUpdate(root);
  await submitRepositoryPlan(run, {
    pages: [
      {
        path: page,
        title: "Testing",
        purpose: "Update testing documentation.",
      },
    ],
  });
  const next = await nextRepositoryPage(run);
  if (next.status !== "pending") throw new Error("Expected pending page.");
  const snapshot = await captureRepositoryPageSnapshot(run, next.job.id);

  await run.backend.write(page, validPage("Changed"));
  await store.writePage(page, {
    schemaVersion: 1,
    pageVersion: await store.hashPage(page),
    claims: [],
  });

  await skipRepositoryPage(run, snapshot);

  expect(await readFile(path.join(root, "openwiki/testing.md"), "utf8")).toBe(
    validPage("testing"),
  );
  expect(await store.loadPage(page)).toEqual(originalClaims);
  expect(run.state.plan?.pages[0]?.status).toBe("skipped");
  expect((await nextRepositoryPage(run)).status).toBe("complete");

  await finishRepositoryRun(run, { skippedPageSnapshots: [snapshot] });

  expect(await readFile(path.join(root, "openwiki/testing.md"), "utf8")).toBe(
    validPage("testing"),
  );
  expect(await store.loadPage(page)).toEqual(originalClaims);
  expect(await readRepositoryRunState(root)).toBeNull();
  expect(
    JSON.parse(
      await readFile(path.join(root, "openwiki/.last-update.json"), "utf8"),
    ),
  ).toMatchObject({
    gitHead: successfulMetadata.gitHead,
    status: "interrupted",
  });
});

test("preserves prior page coverage when a worker is skipped", async () => {
  const root = await createRepository();
  await writeFile(path.join(root, "README.md"), "# Repository at H1\n", "utf8");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "--quiet", "-m", "source at H1"]);

  const firstRun = await beginForcedUpdate(root);
  await submitRepositoryPlan(firstRun, {
    pages: [
      {
        path: "/openwiki/quickstart.md",
        title: "Quickstart",
        purpose: "Refresh the entry point.",
      },
    ],
  });
  await completeCurrentPage(firstRun, "Quickstart at H1");
  await finishRepositoryRun(firstRun);
  const priorCoverage = (await readRepositoryPageManifest(root)).pages[
    "/openwiki/quickstart.md"
  ];
  expect(priorCoverage).toBeDefined();

  await writeFile(path.join(root, "README.md"), "# Repository at H2\n", "utf8");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "--quiet", "-m", "source at H2"]);
  const secondRun = await beginForcedUpdate(root);
  await submitRepositoryPlan(secondRun, {
    pages: [
      {
        path: "/openwiki/quickstart.md",
        title: "Quickstart",
        purpose: "Refresh the entry point again.",
      },
    ],
  });
  const next = await nextRepositoryPage(secondRun);
  if (next.status !== "pending") throw new Error("Expected pending page.");
  const snapshot = await captureRepositoryPageSnapshot(secondRun, next.job.id);
  await secondRun.backend.write(next.job.path, validPage("Partial H2"));
  await skipRepositoryPage(secondRun, snapshot);

  await finishRepositoryRun(secondRun, {
    skippedPageSnapshots: [snapshot],
  });

  expect(
    (await readRepositoryPageManifest(root)).pages["/openwiki/quickstart.md"],
  ).toEqual(priorCoverage);
});

test.each([
  { mode: "init" as const, page: "/openwiki/quickstart.md" },
  { mode: "update" as const, page: "/openwiki/new-page.md" },
])(
  "treats an absent $mode page as a restorable snapshot",
  async ({ mode, page }) => {
    const root = await createRepository();
    const run =
      mode === "init"
        ? requireActiveRun(
            await beginRepositoryRun({ root, mode: "init", actor: ACTOR }),
          )
        : await beginForcedUpdate(root);
    await submitRepositoryPlan(run, {
      pages: [
        {
          path: page,
          title: "New Page",
          purpose: "Document a newly planned page.",
        },
      ],
    });
    const next = await nextRepositoryPage(run);
    if (next.status !== "pending") throw new Error("Expected pending page.");

    const snapshot = await captureRepositoryPageSnapshot(run, next.job.id);

    expect(snapshot).toMatchObject({
      path: page,
      markdown: null,
      claims: null,
    });
    const write = await run.backend.write(page, validPage("Partial"));
    if (write.error) throw new Error(write.error);

    await skipRepositoryPage(run, snapshot);

    await expect(
      readFile(path.join(root, page.replace(/^\//u, "")), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(run.state.plan?.pages[0]?.status).toBe("skipped");
  },
);

beforeEach(() => {
  failureHarness.manifestReplacements = 0;
  failureHarness.manifestWrites = 0;
  failureHarness.metadataWrites = 0;
  failureHarness.stateWrites = 0;
  failureHarness.stateRemovals = 0;
  failureHarness.sourceMutationsAfterManifestReplacement = 0;
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

  test("resumes across producers while rejecting mode and language conflicts", async () => {
    const root = await createRepository();
    const initial = await beginForcedUpdate(root, "Original context");
    expect(initial.state.targetGitHead).toBe(
      await git(root, ["rev-parse", "HEAD"]),
    );

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
    const otherProducer = requireActiveRun(
      await beginRepositoryRun({
        root,
        mode: "update",
        actor: OTHER_ACTOR,
      }),
    );
    expect(otherProducer.state.runId).toBe(initial.state.runId);
    expect(otherProducer.state.actor).toEqual(OTHER_ACTOR);

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
    expect(resumed.state.actor.producerActor).toBe(ACTOR.producerActor);
    expect(resumed.state.planningContext).toBe("Replacement context");
  });

  test("attributes legacy completed work to its original run producer", async () => {
    const root = await createRepository();
    const initial = await beginForcedUpdate(root);
    await submitRepositoryPlan(initial, {
      pages: [
        {
          path: "/openwiki/quickstart.md",
          title: "Quickstart",
          purpose: "Refresh the repository entry point.",
        },
      ],
    });
    await completeCurrentPage(initial, "Quickstart Updated");

    const legacyState = await readRepositoryRunState(root);
    if (!legacyState?.plan?.pages[0]) throw new Error("Expected run state.");
    delete legacyState.plan.pages[0].completedBy;
    await writeFile(
      repositoryRunStatePath(root),
      `${JSON.stringify(legacyState, null, 2)}\n`,
      "utf8",
    );
    const legacyManifest = await readRepositoryPageManifest(root);
    delete legacyManifest.pages["/openwiki/quickstart.md"]?.completedBy;
    delete legacyManifest.pages["/openwiki/quickstart.md"]?.completedRunId;
    await writeRepositoryPageManifest(root, legacyManifest);

    const resumed = requireActiveRun(
      await beginRepositoryRun({
        root,
        mode: "update",
        actor: OTHER_ACTOR,
      }),
    );
    expect(resumed.state.plan?.pages[0]?.completedBy).toBe(ACTOR.producerActor);
    await expect(readRepositoryPageManifest(root)).resolves.toMatchObject({
      pages: {
        "/openwiki/quickstart.md": { completedBy: ACTOR.producerActor },
      },
    });
  });

  test("backfills a legacy target HEAD and replaces it with paired drift state", async () => {
    const root = await createRepository();
    const initial = await beginForcedUpdate(root);
    await submitRepositoryPlan(initial, { pages: [] });
    const legacyState = JSON.parse(
      await readFile(repositoryRunStatePath(root), "utf8"),
    ) as Record<string, unknown>;
    delete legacyState.targetGitHead;
    await writeFile(
      repositoryRunStatePath(root),
      `${JSON.stringify(legacyState, null, 2)}\n`,
      "utf8",
    );

    const sameSource = requireActiveRun(
      await beginRepositoryRun({ root, mode: "update", actor: ACTOR }),
    );
    expect(sameSource.state.targetGitHead).toBe(
      await git(root, ["rev-parse", "HEAD"]),
    );
    expect(sameSource.state.plan).toBeDefined();

    const persisted = JSON.parse(
      await readFile(repositoryRunStatePath(root), "utf8"),
    ) as Record<string, unknown>;
    delete persisted.targetGitHead;
    await writeFile(
      repositoryRunStatePath(root),
      `${JSON.stringify(persisted, null, 2)}\n`,
      "utf8",
    );
    await writeFile(path.join(root, "README.md"), "# Changed source\n", "utf8");
    await git(root, ["add", "README.md"]);
    await git(root, ["commit", "--quiet", "-m", "change source"]);
    const changedHead = await git(root, ["rev-parse", "HEAD"]);

    const drifted = requireActiveRun(
      await beginRepositoryRun({ root, mode: "update", actor: ACTOR }),
    );
    expect(drifted.state.targetGitHead).toBe(changedHead);
    expect(drifted.state.plan).toBeUndefined();
    expect(drifted.state.phase).toBe("planning");
  });

  test("seeds only a verified successful legacy baseline", async () => {
    const completeRoot = await createRepository();
    const completeStore = new ClaimsStore(completeRoot);
    const page = "/openwiki/quickstart.md";
    const pageVersion = await completeStore.hashPage(page);
    await completeStore.writePage(page, {
      schemaVersion: 1,
      pageVersion,
      claims: [],
      verification: { by: "openwiki/test", at: STARTED_AT },
    });
    await git(completeRoot, ["add", "openwiki/.claims/quickstart.json"]);
    await git(completeRoot, ["commit", "--quiet", "-m", "add legacy claims"]);
    const completeHead = await git(completeRoot, ["rev-parse", "HEAD"]);
    const completeMetadataPath = path.join(
      completeRoot,
      "openwiki",
      ".last-update.json",
    );
    const completeMetadata = JSON.parse(
      await readFile(completeMetadataPath, "utf8"),
    ) as Record<string, unknown>;
    await writeFile(
      completeMetadataPath,
      `${JSON.stringify({ ...completeMetadata, gitHead: completeHead }, null, 2)}\n`,
      "utf8",
    );
    const completeResult = await beginRepositoryRun({
      root: completeRoot,
      mode: "update",
      actor: ACTOR,
      now: () => new Date(STARTED_AT),
    });
    expect(completeResult.view.status).toBe("noop");
    const completeManifest = await readRepositoryPageManifest(completeRoot);
    expect(completeManifest.pages[page]).toMatchObject({
      gitHead: completeHead,
      pageVersion,
    });

    const interruptedRoot = await createRepository();
    const interruptedStore = new ClaimsStore(interruptedRoot);
    await interruptedStore.writePage(page, {
      schemaVersion: 1,
      pageVersion: await interruptedStore.hashPage(page),
      claims: [],
      verification: { by: "openwiki/test", at: STARTED_AT },
    });
    const metadataPath = path.join(
      interruptedRoot,
      "openwiki",
      ".last-update.json",
    );
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      metadataPath,
      `${JSON.stringify({ ...metadata, status: "interrupted" }, null, 2)}\n`,
      "utf8",
    );

    await beginForcedUpdate(interruptedRoot);

    await expect(readRepositoryPageManifest(interruptedRoot)).resolves.toEqual({
      schemaVersion: 1,
      pages: {},
    });
  });

  test("fast-forwards every page after a docs-only Git commit", async () => {
    const root = await createRepository(["architecture.md"]);
    const baselineHead = await git(root, ["rev-parse", "HEAD"]);
    await writeWikiPage(root, "index.md", "# Generated index\n");
    await git(root, ["add", "openwiki/index.md"]);
    await git(root, ["commit", "--quiet", "-m", "update generated index"]);
    const currentHead = await git(root, ["rev-parse", "HEAD"]);
    expect(currentHead).not.toBe(baselineHead);

    const result = await beginRepositoryRun({
      root,
      mode: "update",
      actor: ACTOR,
      now: () => new Date(STARTED_AT),
    });

    expect(result.view.status).toBe("noop");
    const manifest = await readRepositoryPageManifest(root);
    expect(Object.keys(manifest.pages)).toEqual([
      "/openwiki/architecture.md",
      "/openwiki/quickstart.md",
    ]);
    expect(
      Object.values(manifest.pages).every(
        (entry) =>
          entry.gitHead === currentHead &&
          entry.sourceFingerprint?.startsWith("sha256:") === true,
      ),
    ).toBe(true);
  });

  test("routes a clean page without manifest coverage to full review", async () => {
    const root = await createRepository();
    await rm(path.join(root, "openwiki", ".claims", "quickstart.json"));
    await git(root, ["add", "openwiki/.claims/quickstart.json"]);
    await git(root, ["commit", "--quiet", "-m", "remove legacy claims"]);

    const result = await beginRepositoryRun({
      root,
      mode: "update",
      actor: ACTOR,
      now: () => new Date(STARTED_AT),
    });

    expect(result.view).toMatchObject({
      status: "active",
      pageUpdateWindows: [
        {
          pages: ["/openwiki/quickstart.md"],
          changedPaths: [],
          fullReview: true,
        },
      ],
    });
  });

  test("falls through to planning when source changes during no-op manifest replacement", async () => {
    const root = await createRepository();
    failureHarness.sourceMutationsAfterManifestReplacement = 1;

    const result = await beginRepositoryRun({
      root,
      mode: "update",
      actor: ACTOR,
      now: () => new Date(STARTED_AT),
    });

    expect(result.view).toMatchObject({
      status: "active",
      changedPaths: ["README.md"],
    });
    await expect(readRepositoryRunState(root)).resolves.toMatchObject({
      phase: "planning",
    });
    await expect(
      readFile(path.join(root, "openwiki", ".last-update.json"), "utf8").then(
        JSON.parse,
      ),
    ).resolves.toMatchObject({ status: "interrupted" });
  });

  test("preserves mixed page baselines in a fresh checkout after partial progress", async () => {
    const root = await createRepository(["second.md"]);
    const baselineHead = await git(root, ["rev-parse", "HEAD"]);
    await writeFile(
      path.join(root, "README.md"),
      "# Repository\n\nChanged for the partial update.\n",
      "utf8",
    );
    await git(root, ["add", "README.md"]);
    await git(root, ["commit", "--quiet", "-m", "change source"]);

    const partialResult = await beginRepositoryRun({
      root,
      mode: "update",
      actor: ACTOR,
      now: () => new Date(STARTED_AT),
    });
    const partialRun = requireActiveRun(partialResult);
    expect(partialResult.view).toMatchObject({
      pageUpdateWindows: [
        {
          baseGitHead: baselineHead,
          pages: ["/openwiki/quickstart.md", "/openwiki/second.md"],
          changedPaths: ["README.md"],
          fullReview: false,
        },
      ],
    });
    await submitRepositoryPlan(partialRun, {
      pages: [
        {
          path: "/openwiki/second.md",
          title: "Second",
          purpose: "Refresh the secondary guide.",
        },
        {
          path: "/openwiki/quickstart.md",
          title: "Quickstart",
          purpose: "Refresh the entry point.",
        },
      ],
    });
    await completeCurrentPage(partialRun, "Second");
    await rm(repositoryRunStatePath(root));
    await git(root, ["add", "openwiki"]);
    await git(root, ["commit", "--quiet", "-m", "merge partial progress"]);
    const partialMergeHead = await git(root, ["rev-parse", "HEAD"]);

    const freshRoot = await mkdtemp(
      path.join(tmpdir(), "openwiki-partial-checkout-"),
    );
    temporaryDirectories.push(freshRoot);
    await git(root, ["clone", "--quiet", root, freshRoot]);
    await expect(readRepositoryRunState(freshRoot)).resolves.toBeNull();

    const freshResult = await beginRepositoryRun({
      root: freshRoot,
      mode: "update",
      actor: ACTOR,
      now: () => new Date(STARTED_AT),
    });
    const freshRun = requireActiveRun(freshResult);
    const windows =
      freshResult.view.status === "active"
        ? freshResult.view.pageUpdateWindows
        : [];
    const currentWindow = windows.find(
      ({ baseGitHead }) => baseGitHead === partialMergeHead,
    );
    const pendingWindow = windows.find(
      ({ baseGitHead }) => baseGitHead === baselineHead,
    );

    expect(freshResult.view).toMatchObject({
      status: "active",
      resumed: false,
      changedPaths: ["README.md"],
    });
    expect(freshRun.state.plan).toBeUndefined();
    expect(currentWindow).toEqual({
      baseGitHead: partialMergeHead,
      pages: ["/openwiki/second.md"],
      changedPaths: [],
      fullReview: false,
    });
    expect(pendingWindow).toEqual({
      baseGitHead: baselineHead,
      pages: ["/openwiki/quickstart.md"],
      changedPaths: ["README.md"],
      fullReview: false,
    });
    await expect(readRepositoryPageManifest(freshRoot)).resolves.toMatchObject({
      pages: {
        "/openwiki/second.md": {
          gitHead: partialMergeHead,
          sourceFingerprint: freshRun.state.sourceFingerprint,
        },
        "/openwiki/quickstart.md": {
          gitHead: baselineHead,
        },
      },
    });
  });
});

describe("repository page queue", () => {
  test("resets an interrupted skipped job to pending on resume", async () => {
    const root = await createRepository(["second.md"]);
    const initial = await beginForcedUpdate(root);
    await submitRepositoryPlan(initial, {
      pages: [
        {
          path: "/openwiki/second.md",
          title: "Second",
          purpose: "Refresh the secondary guide.",
        },
        {
          path: "/openwiki/quickstart.md",
          title: "Quickstart",
          purpose: "Refresh the repository entry point.",
        },
      ],
    });
    const next = await nextRepositoryPage(initial);
    if (next.status !== "pending") throw new Error("Expected pending page.");
    const snapshot = await captureRepositoryPageSnapshot(initial, next.job.id);
    await initial.backend.write(next.job.path, validPage("Partial"));
    await skipRepositoryPage(initial, snapshot);

    const resumed = requireActiveRun(
      await beginRepositoryRun({ root, mode: "update", actor: ACTOR }),
    );

    expect(resumed.state.plan?.pages[0]?.status).toBe("pending");
    await expect(nextRepositoryPage(resumed)).resolves.toMatchObject({
      status: "pending",
      job: { id: next.job.id, path: next.job.path },
    });
  });

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
    await expect(readRepositoryPageManifest(root)).resolves.toMatchObject({
      pages: {
        "/openwiki/quickstart.md": {
          completedBy: ACTOR.producerActor,
          completedRunId: run.state.runId,
          sourceFingerprint: run.state.sourceFingerprint,
          gitHead: run.state.targetGitHead,
        },
      },
    });

    await expect(
      submitRepositoryPage(run, { jobId: next.job.id, claims: [] }),
    ).resolves.toMatchObject({ status: "complete", remaining: 0 });
  });

  test("leaves the queue pending when page-manifest persistence fails", async () => {
    const root = await createRepository();
    const run = await beginForcedUpdate(root);
    const baselineManifest = await readRepositoryPageManifest(root);
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
    failureHarness.manifestWrites = 1;

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
    ).rejects.toThrow("injected page-manifest write failure");

    expect(run.state.plan?.pages[0]?.status).toBe("pending");
    expect((await readRepositoryRunState(root))?.plan?.pages[0]?.status).toBe(
      "pending",
    );
    await expect(readRepositoryPageManifest(root)).resolves.toEqual(
      baselineManifest,
    );
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
    await expect(readRepositoryPageManifest(root)).resolves.toMatchObject({
      pages: {
        "/openwiki/quickstart.md": {
          sourceFingerprint: run.state.sourceFingerprint,
        },
      },
    });

    const resumed = requireActiveRun(
      await beginRepositoryRun({ root, mode: "update", actor: OTHER_ACTOR }),
    );
    expect(resumed.state.plan?.pages[0]?.status).toBe("complete");
    expect(resumed.state.plan?.pages[0]?.completedBy).toBe(ACTOR.producerActor);
    expect(resumed.state.actor).toEqual(OTHER_ACTOR);
    expect((await readRepositoryRunState(root))?.plan?.pages[0]?.status).toBe(
      "complete",
    );
  });

  test("does not promote a pending job from stale manifest coverage", async () => {
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
    await writeRepositoryPageManifest(root, {
      schemaVersion: 1,
      pages: {
        "/openwiki/quickstart.md": {
          sourceFingerprint: run.state.sourceFingerprint,
          ...(run.state.targetGitHead
            ? { gitHead: run.state.targetGitHead }
            : {}),
          pageVersion: `sha256:${"f".repeat(64)}`,
        },
      },
    });

    const resumed = requireActiveRun(
      await beginRepositoryRun({ root, mode: "update", actor: ACTOR }),
    );

    expect(resumed.state.plan?.pages[0]?.status).toBe("pending");
  });

  test("does not promote a pending job from another run's current coverage", async () => {
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
    const manifest = await readRepositoryPageManifest(root);
    const page = manifest.pages["/openwiki/quickstart.md"];
    if (!page) throw new Error("Expected current page coverage.");
    manifest.pages["/openwiki/quickstart.md"] = {
      ...page,
      sourceFingerprint: run.state.sourceFingerprint,
      ...(run.state.targetGitHead ? { gitHead: run.state.targetGitHead } : {}),
      completedBy: OTHER_ACTOR.producerActor,
      completedRunId: randomUUID(),
    };
    await writeRepositoryPageManifest(root, manifest);

    const resumed = requireActiveRun(
      await beginRepositoryRun({ root, mode: "update", actor: ACTOR }),
    );

    expect(resumed.state.plan?.pages[0]).toMatchObject({
      status: "pending",
    });
    expect(resumed.state.plan?.pages[0]).not.toHaveProperty("completedBy");
  });

  test("rejects a completed job whose Markdown lost its durable proof", async () => {
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
    await completeCurrentPage(run, "Quickstart");
    await writeWikiPage(root, "quickstart.md", validPage("Edited Later"));

    await expect(
      beginRepositoryRun({ root, mode: "update", actor: ACTOR }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });

  test("rejects out-of-order submission but repairs invalid frontmatter", async () => {
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
      submitRepositoryPage(run, {
        jobId: jobs[0].id,
        claims: [
          {
            statement: "The repository has a README.",
            evidence: [{ resource: "repo://README.md" }],
          },
        ],
      }),
    ).resolves.toMatchObject({ status: "complete" });
    const repaired = await readFile(
      path.join(root, jobs[0].path.replace(/^\//u, "")),
      "utf8",
    );
    expect(validateOkfFrontmatter(repaired)).toEqual({ valid: true });
    expect(repaired).toContain("# Missing frontmatter");
  });
});

describe("finishRepositoryRun", () => {
  test("preserves per-page provenance across producer handoffs", async () => {
    const root = await createRepository(["second.md"]);
    const first = await beginForcedUpdate(root);
    await submitRepositoryPlan(first, {
      pages: [
        {
          path: "/openwiki/second.md",
          title: "Second",
          purpose: "Refresh the secondary guide.",
        },
        {
          path: "/openwiki/quickstart.md",
          title: "Quickstart",
          purpose: "Refresh the repository entry point.",
        },
      ],
    });
    await completeCurrentPage(first, "Second");

    const second = requireActiveRun(
      await beginRepositoryRun({
        root,
        mode: "update",
        actor: OTHER_ACTOR,
      }),
    );
    expect(second.state.plan?.pages[0]).toMatchObject({
      path: "/openwiki/second.md",
      status: "complete",
      completedBy: ACTOR.producerActor,
    });
    await completeCurrentPage(second, "Quickstart Updated");
    await finishRepositoryRun(second);

    const secondPage = parseFrontmatterFields(
      await readFile(path.join(root, "openwiki", "second.md"), "utf8"),
    );
    const quickstart = parseFrontmatterFields(
      await readFile(path.join(root, "openwiki", "quickstart.md"), "utf8"),
    );
    expect(secondPage?.generated).toMatchObject({ by: ACTOR.producerActor });
    expect(quickstart?.generated).toMatchObject({
      by: OTHER_ACTOR.producerActor,
    });
    await expect(readRepositoryPageManifest(root)).resolves.toMatchObject({
      pages: {
        "/openwiki/second.md": { completedBy: ACTOR.producerActor },
        "/openwiki/quickstart.md": {
          completedBy: OTHER_ACTOR.producerActor,
        },
      },
    });
  });

  test("completes init with canonical bytes and final Claims durable", async () => {
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
    await completeCurrentPage(run, "Quickstart", false);

    await expect(finishRepositoryRun(run)).resolves.toEqual({
      status: "complete",
    });

    expect(await readRepositoryRunState(root)).toBeNull();
    await expect(
      readFile(path.join(root, "openwiki", "old.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const store = new ClaimsStore(root);
    const markdown = await readFile(
      path.join(root, "openwiki", "quickstart.md"),
      "utf8",
    );
    expect(markdown).toMatch(/[^\n]\n$/u);
    expect(markdown).toContain(
      `generated: { by: "${ACTOR.producerActor}", at: "${STARTED_AT}" }`,
    );
    const sidecar = await store.loadPage("/openwiki/quickstart.md");
    expect(sidecar?.pageVersion).toBe(
      await store.hashPage("/openwiki/quickstart.md"),
    );
    expect(sidecar?.verification).toEqual({
      by: OPENWIKI_PRODUCER_ACTOR,
      at: STARTED_AT,
    });
    const fields = parseFrontmatterFields(markdown);
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

  test("finishes with multiline generated metadata instead of corrupting verification", async () => {
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
    const next = await nextRepositoryPage(run);
    if (next.status !== "pending") throw new Error("Expected page job.");
    await run.backend.write(
      next.job.path,
      '---\ntype: Guide\ntitle: Quickstart\ngenerated:\n  by: openwiki/0.4.0\n  at: "2026-08-23T12:00:00.000Z"\n---\n\n# Quickstart\n\nUpdated.\n',
    );
    await submitRepositoryPage(run, {
      jobId: next.job.id,
      claims: [
        {
          statement: "The repository has a README.",
          evidence: [{ resource: "repo://README.md" }],
        },
      ],
    });

    await expect(finishRepositoryRun(run)).resolves.toEqual({
      status: "complete",
    });

    const content = await readFile(
      path.join(root, "openwiki", "quickstart.md"),
      "utf8",
    );
    expect(parseFrontmatterFields(content)).toMatchObject({
      generated: { by: ACTOR.producerActor, at: STARTED_AT },
      verified: [{ by: OPENWIKI_PRODUCER_ACTOR, at: STARTED_AT }],
    });
  });

  test("finishes after deterministically degrading every invalid optional OKF family", async () => {
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
    const next = await nextRepositoryPage(run);
    if (next.status !== "pending") throw new Error("Expected page job.");
    await run.backend.write(
      next.job.path,
      "---\ntype: Guide\ntitle: 9\ndescription: []\nresource: {}\ntimestamp: []\ntags: [docs, 7]\ngenerated: someday\nverified: [{at: someday}]\nsources: [{id: missing-resource}]\nstatus: reviewed\nstale_after: later\nproducer_extension: keep\n---\n\n# Quickstart\n\nUpdated.\n",
    );
    await submitRepositoryPage(run, {
      jobId: next.job.id,
      claims: [
        {
          statement: "The repository has a README.",
          evidence: [{ resource: "repo://README.md" }],
        },
      ],
    });

    await expect(finishRepositoryRun(run)).resolves.toEqual({
      status: "complete",
    });

    const content = await readFile(
      path.join(root, "openwiki", "quickstart.md"),
      "utf8",
    );
    const fields = parseFrontmatterFields(content);
    expect(validateOkfFrontmatter(content)).toEqual({ valid: true });
    expect(fields).toMatchObject({
      generated: { by: ACTOR.producerActor, at: STARTED_AT },
      producer_extension: "keep",
      sources: [expect.objectContaining({ resource: "repo://README.md" })],
      tags: ["docs"],
      title: "Quickstart",
      type: "Guide",
      verified: [{ by: OPENWIKI_PRODUCER_ACTOR, at: STARTED_AT }],
    });
    for (const field of [
      "description",
      "resource",
      "timestamp",
      "status",
      "stale_after",
    ]) {
      expect(fields).not.toHaveProperty(field);
    }
  });

  test("finalizes completed work once without advancing a drifted source", async () => {
    const root = await createRepository(["pre-existing.md"]);
    const run = await beginForcedUpdate(root, "Plan A context");
    await submitRepositoryPlan(run, {
      pages: [
        {
          path: "/openwiki/new-page.md",
          title: "New Page",
          purpose: "Document new work.",
        },
      ],
    });
    await completeCurrentPage(run, "New Page");
    await writeFile(
      path.join(root, "README.md"),
      "# Repository\nSource changed.\n",
      "utf8",
    );

    await expect(finishRepositoryRun(run)).resolves.toEqual({
      status: "complete",
      sourceChanged: true,
    });
    expect(await readRepositoryRunState(root)).toBeNull();

    await expect(
      readFile(path.join(root, "openwiki", "new-page.md"), "utf8"),
    ).resolves.toContain("# New Page");
    await expect(
      readFile(path.join(root, "openwiki", "pre-existing.md"), "utf8"),
    ).resolves.toContain("# pre-existing");
    await expect(
      readFile(path.join(root, "openwiki", ".last-update.json"), "utf8").then(
        JSON.parse,
      ),
    ).resolves.toMatchObject({
      gitHead: run.state.baseGitHead,
      status: "interrupted",
    });
    const manifest = await readRepositoryPageManifest(root);
    expect(
      Object.values(manifest.pages).every(
        (entry) =>
          entry.gitHead === run.state.targetGitHead &&
          entry.sourceFingerprint === run.state.sourceFingerprint,
      ),
    ).toBe(true);
  });

  test("keeps finalized work resumable when drift metadata persistence fails", async () => {
    const root = await createRepository();
    const run = await beginForcedUpdate(root);
    await submitRepositoryPlan(run, { pages: [] });
    await writeFile(
      path.join(root, "README.md"),
      "# Repository\nSource changed.\n",
      "utf8",
    );
    failureHarness.metadataWrites = 1;

    await expect(finishRepositoryRun(run)).rejects.toThrow(
      "injected metadata failure",
    );
    expect((await readRepositoryRunState(root))?.plan).toBeDefined();

    await expect(finishRepositoryRun(run)).resolves.toEqual({
      status: "complete",
      sourceChanged: true,
    });
    expect(await readRepositoryRunState(root)).toBeNull();
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

    await expect(finishRepositoryRun(run)).resolves.toEqual({
      status: "complete",
      sourceChanged: true,
    });
    expect(await readRepositoryRunState(root)).toBeNull();
    await expect(
      readFile(path.join(root, "openwiki", ".last-update.json"), "utf8").then(
        JSON.parse,
      ),
    ).resolves.toMatchObject({
      gitHead: run.state.baseGitHead,
      status: "interrupted",
    });
  });

  test("omits the checkpoint when a drifted init has no successful baseline", async () => {
    const root = await createRepository();
    await rm(path.join(root, "openwiki", ".last-update.json"));
    const run = requireActiveRun(
      await beginRepositoryRun({ root, mode: "init", actor: ACTOR }),
    );
    await submitRepositoryPlan(run, {
      pages: [
        {
          path: "/openwiki/quickstart.md",
          title: "Quickstart",
          purpose: "Document the repository entry point.",
        },
      ],
    });
    await completeCurrentPage(run, "Quickstart");
    await writeFile(
      path.join(root, "README.md"),
      "# Repository\nSource changed during init.\n",
      "utf8",
    );

    await expect(finishRepositoryRun(run)).resolves.toEqual({
      status: "complete",
      sourceChanged: true,
    });

    const metadata = JSON.parse(
      await readFile(path.join(root, "openwiki", ".last-update.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(metadata).toMatchObject({ status: "interrupted" });
    expect(metadata).not.toHaveProperty("gitHead");
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
    const manifest = await readRepositoryPageManifest(root);
    expect(manifest.pages).not.toHaveProperty("/openwiki/delete-me.md");
    expect(manifest.pages).toHaveProperty("/openwiki/keep-me.md");
    expect(manifest.pages).toHaveProperty("/openwiki/quickstart.md");
    expect(
      Object.values(manifest.pages).every(
        (entry) =>
          entry.gitHead === run.state.targetGitHead &&
          entry.sourceFingerprint === run.state.sourceFingerprint,
      ),
    ).toBe(true);
  });

  test("keeps run state and interrupted metadata when manifest replacement fails", async () => {
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
    failureHarness.manifestReplacements = 1;

    await expect(finishRepositoryRun(run)).rejects.toThrow(
      "injected page-manifest replacement failure",
    );

    await expect(readRepositoryRunState(root)).resolves.not.toBeNull();
    await expect(
      readFile(path.join(root, "openwiki", ".last-update.json"), "utf8").then(
        JSON.parse,
      ),
    ).resolves.toMatchObject({ status: "interrupted" });
  });

  test("records drift when source changes during manifest replacement", async () => {
    const root = await createRepository();
    const run = await beginForcedUpdate(root);
    await submitRepositoryPlan(run, { pages: [] });
    failureHarness.sourceMutationsAfterManifestReplacement = 1;

    await expect(finishRepositoryRun(run)).resolves.toEqual({
      status: "complete",
      sourceChanged: true,
    });

    await expect(readRepositoryRunState(root)).resolves.toBeNull();
    await expect(
      readFile(path.join(root, "openwiki", ".last-update.json"), "utf8").then(
        JSON.parse,
      ),
    ).resolves.toMatchObject({ status: "interrupted" });
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
