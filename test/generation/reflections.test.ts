import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  getUpdateNoopStatus,
  writeLastUpdateMetadata,
} from "../../src/agent/utils.ts";
import { ClaimsStore } from "../../src/claims/brains/code/store.ts";
import { HostSessionManager } from "../../src/integrations/core/session-manager.ts";
import { createOpenWikiMcpServer } from "../../src/integrations/mcp/server.ts";
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
import { readRepositoryRunState } from "../../src/generation/run-state.ts";
import { ReflectionStore } from "../../src/memory/reflections.ts";

/**
 * Current isolated repository and its temporary parent directories.
 */
let root: string;

/**
 * Canonical page owning the retry explanation in these lifecycle fixtures.
 */
const PAGE = "/openwiki/quickstart.md";

/**
 * Provisional discovery that corrects the baseline wiki's wording.
 */
const FINDING =
  "The retry limit includes the initial attempt; three attempts permit two retries.";

/**
 * Producer used by deterministic lifecycle tests.
 */
const ACTOR = { producerActor: "host-agent/test", metadataModel: "test" };

/**
 * Executes Git without depending on local identity or signing configuration.
 *
 * @param args - Literal Git arguments.
 * @returns Trimmed UTF-8 output.
 */
function git(...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=OpenWiki Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: root, encoding: "utf8", stdio: "pipe" },
  ).trim();
}

/**
 * Narrows a lifecycle result while surfacing an unexpected no-op.
 *
 * @param begun - Begin or resume result.
 * @returns Active resumable run.
 */
function active(begun: BeginRepositoryRunResult): ActiveRepositoryRun {
  if (!("run" in begun))
    throw new Error("Expected reflection work to prevent a no-op.");
  return begun.run;
}

/**
 * Creates a pending discovery against the real evidence resolver.
 *
 * @param finding - Reusable learning to record.
 * @returns New artifact identity.
 */
function reflect(finding = FINDING) {
  return new ReflectionStore(root).create({
    finding,
    evidence: [{ resource: "repo://src/retry.ts" }],
  });
}

/**
 * Builds the canonical page assignment, retaining every requested reflection ID.
 *
 * @param reflectionIds - Captured findings assigned to this page.
 * @returns Planner input for the retry page.
 */
function planPage(reflectionIds: string[] = []) {
  return {
    path: PAGE,
    title: "Quickstart",
    purpose: "Explain job retry limits.",
    reflectionIds,
  };
}

/**
 * Writes a complete linked page and returns sparse author decisions using stable IDs.
 *
 * @param run - Active run owning the page.
 * @param statement - Explanation asserted by the finished page.
 * @returns Page submission payload; tests add explicit reflection results.
 */
async function author(run: ActiveRepositoryRun, statement = FINDING) {
  const next = await nextRepositoryPage(run);
  if (next.status !== "pending") throw new Error("Expected a pending page.");
  const claims = run.claimsRuntime.session.inspectClaims(PAGE);
  const prose = run.claimsRuntime.session.inspectProse(PAGE);
  await writeFile(
    path.join(root, "openwiki/quickstart.md"),
    `---\ntype: guide\ntitle: Quickstart\ndescription: Job retry limits.\n---\n# Quickstart\n\n${statement}\n`,
  );
  return {
    jobId: next.job.id,
    claims: [
      {
        id: claims[0]?.id,
        statement,
        evidence: [{ resource: "repo://src/retry.ts" }],
      },
    ],
    sections: [
      {
        id: prose?.sections[0]?.id,
        location: "quickstart.md#Quickstart",
        description: "Attempt counting.",
      },
    ],
    bindings: [
      {
        id: prose?.bindings[0]?.id,
        section: "quickstart.md#Quickstart",
        text: statement,
        claims: [statement],
      },
    ],
  };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openwiki-consolidation-"));
  git("init", "--quiet", "-b", "main");
  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "src/retry.ts"),
    "export const attempts = 3;\nexport const initialAttemptCounts = true;\n",
  );
  git("add", ".");
  git("commit", "--quiet", "-m", "source baseline");
  const run = active(
    await beginRepositoryRun({ root, mode: "init", actor: ACTOR }),
  );
  await submitRepositoryPlan(run, { pages: [planPage()] });
  await submitRepositoryPage(
    run,
    await author(run, "Jobs allow three retries."),
  );
  await finishRepositoryRun(run);
  git("add", ".");
  git("commit", "--quiet", "-m", "wiki baseline");
  await writeLastUpdateMetadata(
    "update",
    root,
    "test",
    "repository",
    "complete",
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("reflection consolidation", () => {
  test("adds uncovered knowledge through a new page with newly allocated durable claim and prose links", async () => {
    const finding = await reflect();
    const run = active(
      await beginRepositoryRun({ root, mode: "update", actor: ACTOR }),
    );
    const page = "/openwiki/concepts/retries.md";
    await submitRepositoryPlan(run, {
      pages: [{ ...planPage([finding.id]), path: page }],
    });
    const next = await nextRepositoryPage(run);
    if (next.status !== "pending")
      throw new Error("Expected the new knowledge page.");
    expect(next.job.path).toBe(page);
    expect(next.job.existing).toBe(false);
    await mkdir(path.join(root, "openwiki/concepts"));
    await writeFile(
      path.join(root, "openwiki/concepts/retries.md"),
      `---\ntype: concept\ntitle: Retries\ndescription: Attempt counting.\n---\n# Retries\n\n${FINDING}\n`,
    );
    await submitRepositoryPage(run, {
      jobId: next.job.id,
      claims: [
        { statement: FINDING, evidence: [{ resource: "repo://src/retry.ts" }] },
      ],
      sections: [
        {
          location: "concepts/retries.md#Retries",
          description: "Attempt counting.",
        },
      ],
      bindings: [
        {
          section: "concepts/retries.md#Retries",
          text: FINDING,
          claims: [FINDING],
        },
      ],
      reflectionResults: [{ id: finding.id, claims: [FINDING] }],
    });
    const stored = (await new ClaimsStore(root).loadPage(page))!;
    expect(stored.claims[0].statement).toBe(FINDING);
    expect(stored.bindings![0].claimIds).toEqual([stored.claims[0].id]);
    expect((await new ReflectionStore(root).list()).reflections).toEqual([]);
  });

  test("retains findings when page persistence fails before the durability proof", async () => {
    const finding = await reflect();
    const run = active(
      await beginRepositoryRun({ root, mode: "update", actor: ACTOR }),
    );
    await submitRepositoryPlan(run, { pages: [planPage([finding.id])] });
    const input = {
      ...(await author(run)),
      reflectionResults: [{ id: finding.id, claims: [FINDING] }],
    };
    vi.spyOn(ClaimsStore.prototype, "writePage").mockRejectedValueOnce(
      new Error("injected claims persistence failure"),
    );
    await expect(submitRepositoryPage(run, input)).rejects.toThrow();
    expect(
      (await new ReflectionStore(root).list()).reflections.map(({ id }) => id),
    ).toEqual([finding.id]);
    expect(run.state.plan!.pages[0].status).toBe("pending");
    await submitRepositoryPage(run, input);
    expect((await new ReflectionStore(root).list()).reflections).toEqual([]);
  });

  test("replans only remaining captured findings after source drift", async () => {
    const discarded = await reflect("An unsupported finding.");
    const pending = await reflect();
    const run = active(
      await beginRepositoryRun({ root, mode: "update", actor: ACTOR }),
    );
    await submitRepositoryPlan(run, {
      pages: [planPage([pending.id])],
      discardedReflectionIds: [discarded.id],
    });
    const arrival = await reflect("A later discovery.");
    await writeFile(
      path.join(root, "src/new.ts"),
      "export const added = true;\n",
    );
    const resumed = await beginRepositoryRun({
      root,
      mode: "update",
      actor: ACTOR,
    });
    if (resumed.view.status !== "active")
      throw new Error("Expected replanning.");
    expect(resumed.view.phase).toBe("planning");
    expect(resumed.view.reflections.map(({ id }) => id)).toEqual([pending.id]);
    const replanned = active(resumed);
    await submitRepositoryPlan(replanned, { pages: [planPage([pending.id])] });
    await submitRepositoryPage(replanned, {
      ...(await author(replanned)),
      reflectionResults: [{ id: pending.id, claims: [FINDING] }],
    });
    await finishRepositoryRun(replanned);
    expect(
      (await new ReflectionStore(root).list()).reflections.map(({ id }) => id),
    ).toEqual([arrival.id]);
  });

  test("bypasses a clean no-op and requires exhaustive, unique planning decisions", async () => {
    expect((await getUpdateNoopStatus(root)).shouldSkip).toBe(true);
    const first = await reflect();
    const second = await reflect("Another verified discovery.");
    expect((await getUpdateNoopStatus(root)).shouldSkip).toBe(false);
    const begun = await beginRepositoryRun({
      root,
      mode: "update",
      actor: ACTOR,
    });
    const run = active(begun);
    expect(run.state.initialReflectionIds?.slice().sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(begun.view).toHaveProperty("reflections");
    for (const proposal of [
      { pages: [] },
      {
        pages: [planPage([first.id])],
        discardedReflectionIds: [first.id, second.id],
      },
      { pages: [planPage([first.id, first.id, second.id])] },
      {
        pages: [
          planPage([
            first.id,
            second.id,
            "reflection-00000000-0000-4000-8000-000000000000",
          ]),
        ],
      },
    ])
      await expect(submitRepositoryPlan(run, proposal)).rejects.toMatchObject({
        code: "invalid_input",
      });
    expect(run.state.phase).toBe("planning");
    expect((await new ReflectionStore(root).list()).reflections).toHaveLength(
      2,
    );
    await submitRepositoryPlan(run, {
      pages: [planPage([first.id])],
      discardedReflectionIds: [second.id],
    });
    expect(
      (await new ReflectionStore(root).list()).reflections.map(({ id }) => id),
    ).toEqual([first.id]);
    const next = await nextRepositoryPage(run);
    if (next.status !== "pending")
      throw new Error("Expected assigned discovery.");
    expect(next.job.reflections).toEqual([
      {
        id: first.id,
        finding: FINDING,
        evidence: [{ resource: "repo://src/retry.ts" }],
      },
    ]);
  });

  test("reconciles useful and duplicate findings into one durable claim without storing their outcomes", async () => {
    const first = await reflect();
    const duplicate = await reflect();
    const store = new ClaimsStore(root);
    const previous = (await store.loadPage(PAGE))!;
    const run = active(
      await beginRepositoryRun({ root, mode: "update", actor: ACTOR }),
    );
    await submitRepositoryPlan(run, {
      pages: [planPage([first.id, duplicate.id])],
    });
    await submitRepositoryPage(run, {
      ...(await author(run)),
      reflectionResults: [first, duplicate].map(({ id }) => ({
        id,
        claims: [FINDING],
      })),
    });
    const result = (await store.loadPage(PAGE))!;
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].id).toBe(previous.claims[0].id);
    expect(result.claims[0].statement).toBe(FINDING);
    expect(result.bindings![0].claimIds).toEqual([result.claims[0].id]);
    expect((await new ReflectionStore(root).list()).reflections).toEqual([]);
    const checkpoint = JSON.stringify(await readRepositoryRunState(root));
    expect(checkpoint).not.toContain("reflectionResults");
    expect(checkpoint).not.toContain(result.claims[0].id);
    await finishRepositoryRun(run);
    expect(await readRepositoryRunState(root)).toBeNull();
    expect(await readdir(path.join(root, "openwiki/.reflections"))).toEqual([]);
    const later = await reflect();
    const duplicateRun = active(
      await beginRepositoryRun({ root, mode: "update", actor: ACTOR }),
    );
    await submitRepositoryPlan(duplicateRun, { pages: [planPage([later.id])] });
    const next = await nextRepositoryPage(duplicateRun);
    if (next.status !== "pending")
      throw new Error("Expected duplicate review.");
    const markdown = await store.readMarkdown(PAGE);
    await submitRepositoryPage(duplicateRun, {
      jobId: next.job.id,
      reflectionResults: [{ id: later.id, claims: [result.claims[0].id] }],
    });
    expect((await store.loadPage(PAGE))!.claims.map(({ id }) => id)).toEqual([
      result.claims[0].id,
    ]);
    expect((await store.readMarkdown(PAGE)).split("# Quickstart")[1]).toBe(
      markdown.split("# Quickstart")[1],
    );
    expect((await new ReflectionStore(root).list()).reflections).toEqual([]);
  });

  test("rejects missing, foreign, ambiguous, or unbound results before mutating claim state", async () => {
    const finding = await reflect();
    const run = active(
      await beginRepositoryRun({ root, mode: "update", actor: ACTOR }),
    );
    await submitRepositoryPlan(run, { pages: [planPage([finding.id])] });
    const input = await author(run);
    const original = run.claimsRuntime.session.inspectClaims(PAGE);
    for (const reflectionResults of [
      [],
      [{ id: finding.id, claims: ["missing-claim"] }],
      [{ id: finding.id, claims: [FINDING, original[0].id] }],
      [
        { id: finding.id, claims: [] },
        { id: finding.id, claims: [] },
      ],
      [{ id: "reflection-00000000-0000-4000-8000-000000000000", claims: [] }],
    ]) {
      await expect(
        submitRepositoryPage(run, { ...input, reflectionResults }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(run.claimsRuntime.session.inspectClaims(PAGE)).toEqual(original);
      expect((await new ReflectionStore(root).list()).reflections).toHaveLength(
        1,
      );
    }
    await expect(
      submitRepositoryPage(run, {
        ...input,
        bindings: [],
        removedBindingIds: [
          run.claimsRuntime.session.inspectProse(PAGE)!.bindings[0].id,
        ],
        reflectionResults: [{ id: finding.id, claims: [FINDING] }],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await submitRepositoryPage(run, {
      ...input,
      reflectionResults: [{ id: finding.id, claims: [FINDING] }],
    });
    expect((await new ReflectionStore(root).list()).reflections).toEqual([]);
  });

  test("cleans verified planner discards with no page work and excludes later arrivals across resume", async () => {
    const obsolete = await reflect("Unsupported interpretation.");
    const run = active(
      await beginRepositoryRun({ root, mode: "update", actor: ACTOR }),
    );
    const later = await reflect("Discovery created during this update.");
    const resumed = active(
      await beginRepositoryRun({ root, mode: "update", actor: ACTOR }),
    );
    expect(resumed.state.initialReflectionIds).toEqual([obsolete.id]);
    await expect(
      submitRepositoryPlan(resumed, {
        pages: [],
        discardedReflectionIds: [obsolete.id, later.id],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await submitRepositoryPlan(resumed, {
      pages: [],
      discardedReflectionIds: [obsolete.id],
    });
    await finishRepositoryRun(resumed);
    expect(
      (await new ReflectionStore(root).list()).reflections.map(({ id }) => id),
    ).toEqual([later.id]);
    expect(await readRepositoryRunState(root)).toBeNull();
    expect(run.state.initialReflectionIds).toEqual([obsolete.id]);
  });

  test("keeps assigned discards pending until the page succeeds", async () => {
    const finding = await reflect("An obsolete explanation.");
    const run = active(
      await beginRepositoryRun({ root, mode: "update", actor: ACTOR }),
    );
    await submitRepositoryPlan(run, { pages: [planPage([finding.id])] });
    const next = await nextRepositoryPage(run);
    if (next.status !== "pending") throw new Error("Expected review.");
    await submitRepositoryPage(run, {
      jobId: next.job.id,
      reflectionResults: [{ id: finding.id, claims: [] }],
    });
    expect((await new ReflectionStore(root).list()).reflections).toEqual([]);
    expect(
      (await new ClaimsStore(root).loadPage(PAGE))!.claims[0].statement,
    ).toBe("Jobs allow three retries.");
  });

  test("reports changed or missing evidence without automatically discarding the finding", async () => {
    const finding = await reflect();
    await writeFile(
      path.join(root, "src/retry.ts"),
      "export const attempts = 5;\n",
    );
    const changed = await beginRepositoryRun({
      root,
      mode: "update",
      actor: ACTOR,
    });
    if (changed.view.status !== "active") throw new Error("Expected review.");
    expect(changed.view.reflections[0].evidence).toEqual([
      { resource: "repo://src/retry.ts", issue: "changed" },
    ]);
    await rm(path.join(root, "src/retry.ts"));
    const missing = await beginRepositoryRun({
      root,
      mode: "update",
      actor: ACTOR,
    });
    if (missing.view.status !== "active")
      throw new Error("Expected unresolved review.");
    expect(missing.view.reflections[0].evidence).toEqual([
      { resource: "repo://src/retry.ts", issue: "unresolved" },
    ]);
    expect(
      (await new ReflectionStore(root).list()).reflections.map(({ id }) => id),
    ).toEqual([finding.id]);
  });

  test("leaves the saved page and undeleted discoveries recoverable after partial cleanup failure", async () => {
    const first = await reflect();
    const second = await reflect();
    const run = active(
      await beginRepositoryRun({ root, mode: "update", actor: ACTOR }),
    );
    await submitRepositoryPlan(run, {
      pages: [planPage([first.id, second.id])],
    });
    const originalRemove = ReflectionStore.prototype.remove.bind(
      new ReflectionStore(root),
    );
    vi.spyOn(ReflectionStore.prototype, "remove")
      .mockImplementationOnce(originalRemove)
      .mockRejectedValueOnce(new Error("injected deletion failure"));
    await expect(
      submitRepositoryPage(run, {
        ...(await author(run)),
        reflectionResults: [first, second].map(({ id }) => ({
          id,
          claims: [FINDING],
        })),
      }),
    ).rejects.toThrow("injected deletion failure");
    expect(
      (await new ClaimsStore(root).loadPage(PAGE))!.claims[0].statement,
    ).toBe(FINDING);
    expect((await new ReflectionStore(root).list()).reflections).toHaveLength(
      1,
    );
    expect(run.state.plan!.pages[0].status).toBe("pending");
    const resumed = active(
      await beginRepositoryRun({ root, mode: "update", actor: ACTOR }),
    );
    const next = await nextRepositoryPage(resumed);
    if (next.status !== "pending")
      throw new Error("Deletion must precede page completion.");
    expect(next.job.reflections).toHaveLength(1);
    const claimId = resumed.claimsRuntime.session.inspectClaims(PAGE)[0].id;
    await submitRepositoryPage(resumed, {
      jobId: next.job.id,
      reflectionResults: next.job.reflections.map(({ id }) => ({
        id,
        claims: [claimId],
      })),
    });
    await finishRepositoryRun(resumed);
    expect((await new ReflectionStore(root).list()).reflections).toEqual([]);
  });

  test("retries a planner discard deletion from the durable plan without an outcome registry", async () => {
    const finding = await reflect("Unsupported finding.");
    const run = active(
      await beginRepositoryRun({ root, mode: "update", actor: ACTOR }),
    );
    vi.spyOn(ReflectionStore.prototype, "remove").mockRejectedValueOnce(
      new Error("injected discard deletion failure"),
    );
    await expect(
      submitRepositoryPlan(run, {
        pages: [],
        discardedReflectionIds: [finding.id],
      }),
    ).rejects.toThrow("injected discard deletion failure");
    expect(run.state.phase).toBe("generating");
    expect(JSON.stringify(await readRepositoryRunState(root))).not.toContain(
      "discardedReflectionIds",
    );
    const resumed = active(
      await beginRepositoryRun({ root, mode: "update", actor: ACTOR }),
    );
    await finishRepositoryRun(resumed);
    expect((await new ReflectionStore(root).list()).reflections).toEqual([]);
  });

  test("keeps skipped-page findings pending and the run resumable until consolidation succeeds", async () => {
    const finding = await reflect();
    const run = active(
      await beginRepositoryRun({ root, mode: "update", actor: ACTOR }),
    );
    await submitRepositoryPlan(run, { pages: [planPage([finding.id])] });
    const next = await nextRepositoryPage(run);
    if (next.status !== "pending") throw new Error("Expected page.");
    const snapshot = await captureRepositoryPageSnapshot(run, next.job.id);
    await author(run);
    await skipRepositoryPage(run, snapshot);
    await expect(
      finishRepositoryRun(run, { skippedPageSnapshots: [snapshot] }),
    ).rejects.toThrow("captured reflection(s) remain pending");
    expect(await readRepositoryRunState(root)).not.toBeNull();
    expect((await new ReflectionStore(root).list()).reflections).toHaveLength(
      1,
    );
    const resumed = active(
      await beginRepositoryRun({ root, mode: "update", actor: ACTOR }),
    );
    await submitRepositoryPage(resumed, {
      ...(await author(resumed)),
      reflectionResults: [{ id: finding.id, claims: [FINDING] }],
    });
    await finishRepositoryRun(resumed);
  });

  test("blocks malformed starting records but leaves malformed later arrivals for the next update", async () => {
    const finding = await reflect();
    const original = await readFile(path.join(root, finding.path), "utf8");
    await writeFile(path.join(root, finding.path), "not JSON");
    await expect(
      beginRepositoryRun({ root, mode: "update", actor: ACTOR }),
    ).rejects.toThrow("no unreadable reflection is treated as processed");
    expect(await readRepositoryRunState(root)).toBeNull();
    await writeFile(path.join(root, finding.path), original);
    const run = active(
      await beginRepositoryRun({ root, mode: "update", actor: ACTOR }),
    );
    await writeFile(
      path.join(root, "openwiki/.reflections/later-invalid.json"),
      "not JSON",
    );
    await submitRepositoryPlan(run, {
      pages: [],
      discardedReflectionIds: [finding.id],
    });
    await finishRepositoryRun(run);
    expect(
      await readFile(
        path.join(root, "openwiki/.reflections/later-invalid.json"),
        "utf8",
      ),
    ).toBe("not JSON");
  });

  test("keeps a replaced record pending instead of deleting a discovery that was not evaluated", async () => {
    const finding = await reflect();
    const store = new ReflectionStore(root);
    const original = (await store.list()).reflections[0];
    await writeFile(
      path.join(root, finding.path),
      JSON.stringify({ ...original, finding: "A replacement discovery." }),
    );
    await expect(store.remove(original)).rejects.toThrow(
      "changed during consolidation",
    );
    expect((await store.list()).reflections[0].finding).toBe(
      "A replacement discovery.",
    );
  });

  test("consolidates through MCP after a rejected submission and exposes the result as long-term memory", async () => {
    const finding = await reflect();
    const server = createOpenWikiMcpServer(
      HostSessionManager.create({ host: "codex" }),
    );
    const client = new Client({ name: "consolidation-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const begun = await client.callTool({
        name: "openwiki_begin",
        arguments: { root, mode: "update" },
      });
      const { runId } = z
        .object({ runId: z.string() })
        .parse(begun.structuredContent);
      const incomplete = await client.callTool({
        name: "openwiki_submit_plan",
        arguments: { runId, pages: [] },
      });
      expect(incomplete.isError).toBe(true);
      const planned = await client.callTool({
        name: "openwiki_submit_plan",
        arguments: { runId, pages: [planPage([finding.id])] },
      });
      expect(planned.isError).not.toBe(true);
      const next = await client.callTool({
        name: "openwiki_next_page",
        arguments: { runId },
      });
      const { job } = z
        .object({
          job: z.object({
            id: z.string(),
            reflections: z.array(z.object({ id: z.string() })),
          }),
        })
        .parse(next.structuredContent);
      expect(job.reflections.map(({ id }) => id)).toEqual([finding.id]);
      const missing = await client.callTool({
        name: "openwiki_submit_page",
        arguments: { runId, jobId: job.id },
      });
      expect(missing.isError).toBe(true);
      const state = (await new ClaimsStore(root).loadPage(PAGE))!;
      await writeFile(
        path.join(root, "openwiki/quickstart.md"),
        `---\ntype: guide\ntitle: Quickstart\ndescription: Retry limits.\n---\n# Quickstart\n\n${FINDING}\n`,
      );
      const saved = await client.callTool({
        name: "openwiki_submit_page",
        arguments: {
          runId,
          jobId: job.id,
          claims: [
            {
              id: state.claims[0].id,
              statement: FINDING,
              evidence: [{ resource: "repo://src/retry.ts" }],
            },
          ],
          bindings: [
            {
              id: state.bindings![0].id,
              section: state.sections![0].id,
              text: FINDING,
              claims: [state.claims[0].id],
            },
          ],
          reflectionResults: [{ id: finding.id, claims: [state.claims[0].id] }],
        },
      });
      expect(saved.isError).not.toBe(true);
      const finished = await client.callTool({
        name: "openwiki_finish",
        arguments: { runId },
      });
      expect(finished.isError).not.toBe(true);
      const retrieved = await client.callTool({
        name: "openwiki_read",
        arguments: { root, page: "quickstart.md" },
      });
      expect(retrieved.structuredContent).toMatchObject({
        longTerm: { claims: [{ id: state.claims[0].id, statement: FINDING }] },
        shortTerm: { reflections: [] },
        working: { reflections: [] },
      });
      expect((await new ReflectionStore(root).list()).reflections).toEqual([]);
    } finally {
      await client.close();
      if (server.isConnected()) await server.close();
    }
  });
});
