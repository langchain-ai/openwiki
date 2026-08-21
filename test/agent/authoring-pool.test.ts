import { describe, expect, test } from "vitest";
import { createOpenWikiAuthoringPoolMiddleware } from "../../src/agent/authoring-pool.ts";
import {
  canonicalWikiPage,
  createPlanStore,
  type PlannedPage,
} from "../../src/agent/plan-store.ts";

/** A plan store holding complete evidence for the given pages. */
function stubStore(paths: string[]) {
  const store = createPlanStore();
  const pages = new Map<string, PlannedPage>(
    paths.map((path) => [
      canonicalWikiPage(path),
      {
        path,
        responsibility: "Owns the thing",
        entrypoint: "main.go#main",
        sources: ["smith-go/main.go#main"],
        tests: ["smith-go/main_test.go — make test"],
        edges: [{ page: path, relationship: "self" }],
      },
    ]),
  );
  store.set({ entries: [], pages });
  return store;
}

/** Claim session stub: records what each page established. */
function stubSession(claimsByPage: Record<string, number> = {}) {
  return {
    inspectClaims: (page: string) =>
      Array.from({ length: claimsByPage[page] ?? 0 }, (_, i) => ({
        id: `c${i}`,
      })),
  } as unknown as Parameters<typeof createOpenWikiAuthoringPoolMiddleware>[0];
}

/** Wires the middleware to a scripted task tool, as the agent supplies it. */
function authorPagesWith(
  respond: (description: string) => Promise<unknown>,
  session?: Parameters<typeof createOpenWikiAuthoringPoolMiddleware>[2],
  record?: { inFlight: number; peak: number },
  planned: string[] = [
    "openwiki/a.md",
    "openwiki/b.md",
    "openwiki/c.md",
    "openwiki/slow.md",
    ...Array.from({ length: 8 }, (_, i) => `openwiki/p${i}.md`),
  ],
) {
  const middleware = createOpenWikiAuthoringPoolMiddleware(
    stubStore(planned),
    // These tests are about the pool, so the plan is taken as ready.
    () => Promise.resolve({ blocking: [], shortfall: [] }),
    session,
  );
  const seen: string[] = [];
  const task = {
    name: "task",
    invoke: async (input: unknown) => {
      const { description } = input as { description: string };
      seen.push(description);
      if (record) {
        record.inFlight += 1;
        record.peak = Math.max(record.peak, record.inFlight);
      }
      try {
        return await respond(description);
      } finally {
        if (record) record.inFlight -= 1;
      }
    },
  };
  const tools = (
    middleware as { tools: { invoke: (i: unknown) => Promise<unknown> }[] }
  ).tools;
  (
    middleware as {
      wrapModelCall: (r: unknown, h: (r: unknown) => unknown) => unknown;
    }
  ).wrapModelCall({ tools: [task] }, (r) => r);
  return {
    seen,
    run: async (input: unknown) =>
      JSON.parse(String(await tools[0].invoke(input))) as Record<
        string,
        unknown
      >,
  };
}

const ok = () => Promise.resolve("Wrote the page and established its claims.");

describe("author_pages", () => {
  test("counts claims from the store, not from what the author says", async () => {
    // Asking the author to report its own count put the same payload through
    // the same seam under a different name. A report can disagree with the
    // store; the store cannot disagree with itself.
    const h = authorPagesWith(
      ok,
      stubSession({ "/openwiki/a.md": 41, "/openwiki/b.md": 12 }),
    );
    const out = await h.run({
      assignments: [{ page: "a.md" }, { page: "openwiki/b.md" }],
    });
    expect(out.authored).toBe(2);
    expect(out.claimsEstablished).toBe(53);
    expect(out.failed).toEqual([]);
  });

  test("treats zero claims as a failed task, not a page to re-dispatch", async () => {
    // A page is written only alongside its claims, so an author that
    // established none produced nothing. Re-dispatching the same brief that
    // already produced nothing is how a run spent 136 author calls on 68 pages.
    const h = authorPagesWith(ok, stubSession({ "/openwiki/a.md": 30 }));
    const out = await h.run({
      assignments: [{ page: "a.md" }, { page: "b.md" }],
    });
    expect(out.authored).toBe(1);
    expect(out.claimsEstablished).toBe(30);
    const failed = out.failed as { page: string; error: string }[];
    expect(failed[0].page).toBe("/openwiki/b.md");
    expect(failed[0].error).toContain(
      "Do not re-dispatch this brief unchanged",
    );
  });

  test("one author's failure costs its page, not the pool", async () => {
    const h = authorPagesWith(
      (d) =>
        d.includes("page b.md")
          ? Promise.reject(new Error("author died"))
          : ok(),
      stubSession({ "/openwiki/a.md": 5, "/openwiki/c.md": 5 }),
    );
    const out = await h.run({
      assignments: [{ page: "a.md" }, { page: "b.md" }, { page: "c.md" }],
    });
    expect(out.authored).toBe(2);
    expect((out.failed as { page: string }[])[0].page).toBe("/openwiki/b.md");
  });

  test("refills as authors settle instead of waiting for a batch", async () => {
    // A fixed slice waits for its slowest member; a pool keeps the limit
    // saturated while work remains.
    const record = { inFlight: 0, peak: 0 };
    const h = authorPagesWith(
      (d) =>
        new Promise((resolve) =>
          setTimeout(() => resolve("done"), d.includes("slow.md") ? 40 : 1),
        ),
      stubSession(),
      record,
    );
    const out = await h.run({
      assignments: [
        { page: "slow.md" },
        ...Array.from({ length: 8 }, (_, i) => ({
          page: `p${i}.md`,
        })),
      ],
      concurrency: 2,
    });
    // Every page in this stub established zero claims, so all nine are failed
    // tasks; what is being asserted here is the pool's shape, not their success.
    expect((out.failed as unknown[]).length).toBe(9);
    expect(record.peak).toBeLessThanOrEqual(2);
  });

  test("never runs two authors for one page", async () => {
    // Two authors on one page race on write_file and the loser's work is gone.
    const h = authorPagesWith(ok, stubSession());
    const out = await h.run({
      assignments: [{ page: "a.md" }, { page: "a.md" }],
    });
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]).toContain("Write the OpenWiki page openwiki/a.md");
    expect(out.duplicatePagesIgnored).toEqual(["a.md"]);
  });
});

describe("author_pages readiness gate", () => {
  test("refuses to author from a plan that is not ready", async () => {
    // submit_plan accumulates and no longer rejects an incomplete plan, so a
    // subtree no entry covers has to be caught here - it would otherwise be
    // absent from the result with nothing downstream able to tell.
    const middleware = createOpenWikiAuthoringPoolMiddleware(
      stubStore(["openwiki/a.md"]),
      () =>
        Promise.resolve({
          blocking: ["12 director(ies) covered by no entry: /x"],
          shortfall: [],
        }),
    );
    const tools = (
      middleware as { tools: { invoke: (i: unknown) => Promise<unknown> }[] }
    ).tools;
    (
      middleware as {
        wrapModelCall: (r: unknown, h: (r: unknown) => unknown) => unknown;
      }
    ).wrapModelCall(
      { tools: [{ name: "task", invoke: () => Promise.resolve("ok") }] },
      (r) => r,
    );
    const out = JSON.parse(
      String(await tools[0].invoke({ assignments: [{ page: "a.md" }] })),
    ) as Record<string, unknown>;
    expect(out.authored).toBe(0);
    expect(String(out.blocked)).toContain("covered by no entry");
  });
});

describe("author_pages and a thin plan", () => {
  test("authors the pages anyway and reports the shortfall", async () => {
    // The failure this guards: with decomposition refusing here, a plan short of
    // what the repository holds produced ten runs that wrote one page each. A
    // refusal at authoring cannot be undone - nothing reaches disk - so the
    // shortfall travels back with the pages and finalize_wiki answers for it.
    const middleware = createOpenWikiAuthoringPoolMiddleware(
      stubStore(["openwiki/a.md"]),
      () =>
        Promise.resolve({
          blocking: [],
          shortfall: ["/big plans 2 page(s) for 1537 source files"],
        }),
      stubSession({ "/openwiki/a.md": 7 }),
    );
    const tools = (
      middleware as { tools: { invoke: (i: unknown) => Promise<unknown> }[] }
    ).tools;
    (
      middleware as {
        wrapModelCall: (r: unknown, h: (r: unknown) => unknown) => unknown;
      }
    ).wrapModelCall(
      { tools: [{ name: "task", invoke: () => Promise.resolve("ok") }] },
      (r) => r,
    );
    const out = JSON.parse(
      String(await tools[0].invoke({ assignments: [{ page: "a.md" }] })),
    ) as Record<string, unknown>;
    expect(out.authored).toBe(1);
    expect(String(out.planShortfall)).toContain("1537 source files");
  });
});

describe("author_pages gate is bounded", () => {
  test("yields after two refusals rather than authoring nothing", async () => {
    // Refusing forever is worse than an incomplete wiki, so the coverage check
    // yields once it has been ignored MAX_BLOCKED_ATTEMPTS times.
    const middleware = createOpenWikiAuthoringPoolMiddleware(
      stubStore(["openwiki/a.md"]),
      () =>
        Promise.resolve({
          blocking: ["12 director(ies) covered by no entry: /x"],
          shortfall: [],
        }),
      stubSession({ "/openwiki/a.md": 7 }),
    );
    const tools = (
      middleware as { tools: { invoke: (i: unknown) => Promise<unknown> }[] }
    ).tools;
    (
      middleware as {
        wrapModelCall: (r: unknown, h: (r: unknown) => unknown) => unknown;
      }
    ).wrapModelCall(
      { tools: [{ name: "task", invoke: () => Promise.resolve("ok") }] },
      (r) => r,
    );
    const call = async () =>
      JSON.parse(
        String(await tools[0].invoke({ assignments: [{ page: "a.md" }] })),
      ) as Record<string, unknown>;

    // Six refusals: enough that complying is the path of least resistance,
    // finite so no run ends with a complete plan and one page on disk.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect((await call()).authored).toBe(0);
    }
    expect((await call()).authored).toBe(1);
  });
});
