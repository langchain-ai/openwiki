import { describe, expect, test } from "vitest";
import { ClaimSession } from "../../src/claims/brains/code/session.ts";
import type { PageClaims } from "../../src/claims/brains/code/types.ts";
import type { Claim, EvidenceResolver } from "../../src/claims/core/types.ts";
import { RepositoryRunError } from "../../src/generation/errors.ts";
import {
  createRepositoryPlan,
  replacePageClaims,
} from "../../src/generation/page-jobs.ts";

const PAGE = "/openwiki/page.md";
const PAGE_VERSION = `sha256:${"a".repeat(64)}`;

/**
 * Creates a resolver that versions every non-missing resource deterministically.
 *
 * @param missing - Resource identities that should fail resolution.
 * @returns Evidence resolver suitable for pure Claim reconciliation tests.
 */
function createResolver(
  missing: ReadonlySet<string> = new Set(),
): EvidenceResolver {
  return {
    resolve: (resource) =>
      Promise.resolve(
        missing.has(resource)
          ? null
          : {
              evidence: { resource, version: `version:${resource}` },
              content: `content:${resource}`,
            },
      ),
  };
}

/**
 * Creates one page-local Claims session with deterministic allocated IDs.
 *
 * @param claims - Complete persisted Claims for the test page.
 * @param options - Optional resolver and allocated identifiers.
 * @returns Isolated process-local Claim session.
 */
function createSession(
  claims: Claim[],
  options: {
    resolver?: EvidenceResolver;
    ids?: string[];
  } = {},
): ClaimSession {
  const persisted: PageClaims = {
    schemaVersion: 1,
    pageVersion: PAGE_VERSION,
    claims,
  };
  const ids = [...(options.ids ?? ["claim_new"])];
  return new ClaimSession({
    resolver: options.resolver ?? createResolver(),
    persisted: new Map([[PAGE, persisted]]),
    issues: [],
    orphanPages: [],
    createClaimId: () => ids.shift() ?? "claim_fallback",
  });
}

/**
 * Creates a minimal valid planned page proposal.
 *
 * @param page - Candidate generated Markdown path.
 * @returns Complete proposal accepted by plan normalization.
 */
function proposedPage(page: string) {
  return {
    path: page,
    title: ` ${page} `,
    purpose: " Document the subsystem. ",
  };
}

describe("createRepositoryPlan", () => {
  test("requires quickstart for init and forbids init deletions", () => {
    expect(() =>
      createRepositoryPlan("init", { pages: [proposedPage("page.md")] }, []),
    ).toThrow("Init plan must include /openwiki/quickstart.md");

    expect(() =>
      createRepositoryPlan(
        "init",
        {
          pages: [proposedPage("quickstart.md")],
          deletePages: ["old.md"],
        },
        [],
      ),
    ).toThrow("Init plans cannot delete generated pages");
  });

  test("forbids quickstart deletion", () => {
    expect(() =>
      createRepositoryPlan(
        "update",
        { pages: [], deletePages: ["quickstart.md"] },
        [],
      ),
    ).toThrow("quickstart.md page cannot be deleted");
  });

  test("rejects duplicate pages and generate/delete overlap", () => {
    expect(() =>
      createRepositoryPlan(
        "update",
        { pages: [proposedPage("page.md"), proposedPage("openwiki/page.md")] },
        [],
      ),
    ).toThrow("Duplicate planned page: /openwiki/page.md");

    expect(() =>
      createRepositoryPlan(
        "update",
        {
          pages: [proposedPage("page.md")],
          deletePages: ["/openwiki/page.md"],
        },
        [],
      ),
    ).toThrow("both generated and deleted");
  });

  test("rejects structural and reserved working pages", () => {
    for (const page of ["index.md", "nested/_draft.md"]) {
      expect(() =>
        createRepositoryPlan("update", { pages: [proposedPage(page)] }, []),
      ).toThrow(RepositoryRunError);
    }
  });

  test("normalizes page inputs and orders quickstart last", () => {
    const plan = createRepositoryPlan(
      "init",
      {
        pages: [
          {
            ...proposedPage("quickstart.md"),
            seedPaths: [" src\\z.ts ", "src/a.ts", "src/a.ts"],
            relatedPages: ["zeta.md", "openwiki/alpha.md", "zeta.md"],
            instructions: [" Be concise. ", "", "Be concise.", "Accurate."],
          },
          proposedPage("Zeta.md"),
          proposedPage("alpha.md"),
        ],
      },
      [],
    );

    expect(plan.deletePages).toEqual([]);
    expect(plan.pages.map(({ path }) => path)).toEqual([
      "/openwiki/Zeta.md",
      "/openwiki/alpha.md",
      "/openwiki/quickstart.md",
    ]);
    expect(plan.pages[2]).toMatchObject({
      title: "quickstart.md",
      purpose: "Document the subsystem.",
      seedPaths: ["src/a.ts", "src/z.ts"],
      relatedPages: ["/openwiki/alpha.md", "/openwiki/zeta.md"],
      instructions: ["Accurate.", "Be concise."],
      status: "pending",
    });
    expect(plan.pages.every(({ id }) => /^[0-9a-f-]{36}$/u.test(id))).toBe(
      true,
    );
  });

  test("adds required Claim-issue jobs with normalized evidence seeds", () => {
    const plan = createRepositoryPlan("update", { pages: [] }, [
      {
        page: PAGE,
        kind: "stale",
        claimId: "claim_a",
        resources: ["repo://src/z.ts#L2-L4", "repo://src/a.ts"],
      },
      {
        page: PAGE,
        kind: "unresolved",
        claimId: "claim_b",
        resources: ["repo://src/a.ts"],
      },
    ]);

    expect(plan.pages).toHaveLength(1);
    expect(plan.pages[0]).toMatchObject({
      path: PAGE,
      title: "Page",
      seedPaths: ["src/a.ts", "src/z.ts"],
      status: "pending",
    });
    expect(plan.pages[0]?.purpose).toContain("Reconcile stale or unresolved");
  });

  test("adds required language rewrites without duplicating planned or deleted pages", () => {
    const plan = createRepositoryPlan(
      "update",
      {
        pages: [proposedPage("planned.md")],
        deletePages: ["deleted.md"],
      },
      [
        {
          page: "/openwiki/planned.md",
          kind: "stale",
          claimId: "claim_planned",
          resources: ["repo://planned.ts"],
        },
        {
          page: "/openwiki/deleted.md",
          kind: "stale",
          claimId: "claim_deleted",
          resources: ["repo://deleted.ts"],
        },
      ],
      [
        "/openwiki/planned.md",
        "/openwiki/deleted.md",
        "/openwiki/rewrite-me.md",
      ],
    );

    expect(plan.pages.map(({ path }) => path)).toEqual([
      "/openwiki/planned.md",
      "/openwiki/rewrite-me.md",
    ]);
    expect(plan.pages[1]).toMatchObject({
      title: "Rewrite Me",
      seedPaths: [],
      relatedPages: [],
      instructions: [],
    });
    expect(plan.pages[1]?.purpose).toContain("target language");
  });
});

describe("replacePageClaims", () => {
  const existing: Claim[] = [
    {
      id: "claim_keep",
      statement: "The feature exists.",
      evidence: [{ resource: "repo://feature.ts", version: "version:old" }],
    },
    {
      id: "claim_update",
      statement: "The old value is enabled.",
      evidence: [{ resource: "repo://old.ts", version: "version:old" }],
    },
    {
      id: "claim_retract",
      statement: "The removed feature exists.",
      evidence: [{ resource: "repo://removed.ts", version: "version:old" }],
    },
  ];

  test("adds, confirms, updates, and retracts a complete Claim set", async () => {
    const session = createSession(existing, { ids: ["claim_added"] });

    await replacePageClaims(session, PAGE, [
      {
        id: "claim_keep",
        statement: "The feature exists.",
        evidence: [{ resource: "repo://feature.ts" }],
      },
      {
        id: "claim_update",
        statement: "The new value is enabled.",
        evidence: [{ resource: "repo://new.ts" }],
      },
      {
        statement: "A second feature exists.",
        evidence: [{ resource: "repo://second.ts" }],
      },
    ]);

    expect(session.inspectClaims(PAGE)).toEqual([
      {
        id: "claim_keep",
        statement: "The feature exists.",
        evidence: ["repo://feature.ts"],
      },
      {
        id: "claim_update",
        statement: "The new value is enabled.",
        evidence: ["repo://new.ts"],
      },
      {
        id: "claim_added",
        statement: "A second feature exists.",
        evidence: ["repo://second.ts"],
      },
    ]);
  });

  test("preserves an exact no-ID match and normalizes evidence as a set", async () => {
    const session = createSession(existing);

    await replacePageClaims(session, PAGE, [
      {
        statement: " The feature exists. ",
        evidence: [
          { resource: " repo://feature.ts " },
          { resource: "repo://feature.ts" },
        ],
      },
    ]);

    expect(session.inspectClaims(PAGE)).toEqual([
      {
        id: "claim_keep",
        statement: "The feature exists.",
        evidence: ["repo://feature.ts"],
      },
    ]);
  });

  test("rejects duplicate complete proposals", async () => {
    const session = createSession(existing);
    const proposal = {
      statement: "The feature exists.",
      evidence: [{ resource: "repo://feature.ts" }],
    };

    await expect(
      replacePageClaims(session, PAGE, [proposal, proposal]),
    ).rejects.toThrow("Duplicate proposed Claim");
    expect(session.inspectClaims(PAGE).map(({ id }) => id)).toEqual([
      "claim_keep",
      "claim_update",
      "claim_retract",
    ]);
  });

  test("does not conflate Claim fingerprints containing delimiter characters", async () => {
    const session = createSession([], {
      ids: ["claim_first", "claim_second"],
    });

    await replacePageClaims(session, PAGE, [
      {
        statement: "alpha\u0000beta",
        evidence: [{ resource: "repo://gamma.ts" }],
      },
      {
        statement: "alpha",
        evidence: [{ resource: "beta\u0000repo://gamma.ts" }],
      },
    ]);

    expect(session.inspectClaims(PAGE)).toHaveLength(2);
  });

  test("rejects unknown and wrong-page Claim identifiers", async () => {
    const session = createSession(existing);
    await session.resolveClaims({
      page: "/openwiki/other.md",
      operations: [
        {
          op: "add",
          statement: "The other page exists.",
          evidence: [{ resource: "repo://other.ts" }],
        },
      ],
    });
    const otherId = session.inspectClaims("/openwiki/other.md")[0]?.id;

    for (const id of ["claim_unknown", otherId]) {
      await expect(
        replacePageClaims(session, PAGE, [
          {
            id,
            statement: "A proposal.",
            evidence: [{ resource: "repo://feature.ts" }],
          },
        ]),
      ).rejects.toThrow(`Claim ${id} is not owned by ${PAGE}`);
    }
  });

  test("keeps session state atomic when evidence resolution fails", async () => {
    const session = createSession(existing, {
      resolver: createResolver(new Set(["repo://missing.ts"])),
    });
    const before = session.inspectClaims(PAGE);

    await expect(
      replacePageClaims(session, PAGE, [
        {
          id: "claim_keep",
          statement: "Changed before failure.",
          evidence: [{ resource: "repo://feature.ts" }],
        },
        {
          id: "claim_update",
          statement: "This cannot resolve.",
          evidence: [{ resource: "repo://missing.ts" }],
        },
      ]),
    ).rejects.toThrow("Evidence does not resolve: repo://missing.ts");
    expect(session.inspectClaims(PAGE)).toEqual(before);
  });
});
