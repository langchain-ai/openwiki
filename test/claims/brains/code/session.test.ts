import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ClaimsPersistenceError,
  ClaimsPersistenceSecurityError,
} from "../../../../src/claims/core/errors.ts";
import { ClaimSession } from "../../../../src/claims/brains/code/session.ts";
import { ClaimsStore } from "../../../../src/claims/brains/code/store.ts";
import type { PageClaims } from "../../../../src/claims/brains/code/types.ts";
import type {
  Claim,
  EvidenceResolver,
  ResolvedEvidence,
} from "../../../../src/claims/core/types.ts";

const PAGE_VERSION = `sha256:${"a".repeat(64)}`;
const VERIFICATION = {
  by: "openwiki/0.3.3",
  at: "2026-08-20T12:00:00.000Z",
};
const CLAIM: Claim = {
  id: "claim_existing",
  statement: "The feature is enabled.",
  evidence: [{ resource: "memory://feature", version: "revision:1" }],
};

function resolved(resource: string, version: string): ResolvedEvidence {
  return { evidence: { resource, version }, content: `content:${resource}` };
}

function createResolver(
  outcomes: ReadonlyMap<string, ResolvedEvidence | null | Error>,
  calls?: string[],
): EvidenceResolver {
  return {
    resolve(resource) {
      calls?.push(resource);
      const outcome = outcomes.get(resource);
      return outcome instanceof Error
        ? Promise.reject(outcome)
        : Promise.resolve(outcome ?? null);
    },
  };
}

function persisted(claims: Claim[]): PageClaims {
  return { schemaVersion: 1, pageVersion: PAGE_VERSION, claims };
}

describe("ClaimSession", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "openwiki-session-"));
  });

  afterEach(async () => {
    await rm(rootDir, { force: true, recursive: true });
  });

  async function writePage(page: string, content = "# Page\n"): Promise<void> {
    const absolute = path.join(rootDir, page.replace(/^\/+/u, ""));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }

  function createSession(options?: {
    issues?: ConstructorParameters<typeof ClaimSession>[0]["issues"];
    orphanPages?: string[];
    resolver?: EvidenceResolver;
    createClaimId?: () => string;
  }): ClaimSession {
    const page = "/openwiki/page.md";
    return new ClaimSession({
      resolver:
        options?.resolver ??
        createResolver(
          new Map([
            ["memory://feature", resolved("memory://feature", "revision:2")],
          ]),
        ),
      persisted: new Map([[page, persisted([CLAIM])]]),
      issues: options?.issues ?? [],
      orphanPages: options?.orphanPages ?? [],
      createClaimId: options?.createClaimId,
    });
  }

  test("inspects compact cloned page state with deterministic issues", () => {
    const session = createSession({
      issues: [
        {
          page: "/openwiki/page.md",
          kind: "stale",
          claimId: "claim_existing",
          resources: ["memory://feature"],
        },
      ],
    });

    const claims = session.inspectClaims("/openwiki/page.md");
    expect(claims).toEqual([
      {
        id: "claim_existing",
        statement: "The feature is enabled.",
        evidence: ["memory://feature"],
        issue: { kind: "stale", resources: ["memory://feature"] },
      },
    ]);
    claims[0].statement = "mutated";
    expect(session.inspectClaims("/openwiki/page.md")[0]?.statement).toBe(
      "The feature is enabled.",
    );
  });

  test("projects deterministic unique evidence resources by page", () => {
    const repeated: Claim = {
      id: "claim_repeated",
      statement: "The feature is reused.",
      evidence: [
        { resource: "memory://zeta", version: "revision:1" },
        { resource: "memory://feature", version: "revision:1" },
      ],
    };
    const session = new ClaimSession({
      resolver: createResolver(new Map()),
      persisted: new Map([
        ["/openwiki/page.md", persisted([CLAIM, repeated])],
        ["/openwiki/empty.md", persisted([])],
      ]),
      issues: [],
      orphanPages: [],
    });

    expect([...session.getEvidenceResourcesByPage()]).toEqual([
      ["/openwiki/empty.md", []],
      ["/openwiki/page.md", ["memory://feature", "memory://zeta"]],
    ]);
  });

  test("rejects duplicate claim IDs across persisted pages", () => {
    expect(
      () =>
        new ClaimSession({
          resolver: createResolver(new Map()),
          persisted: new Map([
            ["/openwiki/page.md", persisted([CLAIM])],
            ["/openwiki/second.md", persisted([CLAIM])],
          ]),
          issues: [],
          orphanPages: [],
        }),
    ).toThrow("Duplicate claim id claim_existing");
  });

  test("keeps ID ownership aligned with additions and retractions", async () => {
    const session = createSession({ createClaimId: () => "claim_new" });
    await session.resolveClaims({
      page: "/openwiki/second.md",
      operations: [
        {
          op: "add",
          statement: "The second feature exists.",
          evidence: [{ resource: "memory://feature" }],
        },
      ],
    });
    expect(session.inspectClaims("/openwiki/second.md")[0]?.id).toBe(
      "claim_new",
    );

    await session.resolveClaims({
      page: "/openwiki/second.md",
      operations: [{ op: "retract", id: "claim_new" }],
    });
    expect(session.inspectClaims("/openwiki/second.md")).toEqual([]);
  });

  test("returns compact operation results including allocated IDs", async () => {
    const session = createSession({ createClaimId: () => "claim_new" });
    const result = await session.resolveClaims({
      page: "/openwiki/page.md",
      operations: [
        {
          op: "update",
          id: "claim_existing",
          statement: "The feature remains enabled.",
        },
        {
          op: "add",
          statement: "The feature is configurable.",
          evidence: [{ resource: "memory://feature" }],
        },
      ],
    });

    expect(result).toEqual({
      page: "/openwiki/page.md",
      results: [
        { op: "update", id: "claim_existing" },
        { op: "add", id: "claim_new" },
      ],
    });
  });

  test("serializes concurrent mutations on one page", async () => {
    let releaseFirst = (): void => undefined;
    const firstResolution = new Promise<ResolvedEvidence>((resolve) => {
      releaseFirst = () => resolve(resolved("memory://first", "revision:1"));
    });
    const resolver: EvidenceResolver = {
      resolve(resource) {
        return resource === "memory://first"
          ? firstResolution
          : Promise.resolve(resolved(resource, "revision:1"));
      },
    };
    let nextId = 0;
    const session = new ClaimSession({
      resolver,
      persisted: new Map(),
      issues: [],
      orphanPages: [],
      createClaimId: () => `claim_${++nextId}`,
    });
    const first = session.resolveClaims({
      page: "/openwiki/page.md",
      operations: [
        {
          op: "add",
          statement: "First.",
          evidence: [{ resource: "memory://first" }],
        },
      ],
    });
    const second = session.resolveClaims({
      page: "/openwiki/page.md",
      operations: [
        {
          op: "add",
          statement: "Second.",
          evidence: [{ resource: "memory://second" }],
        },
      ],
    });
    releaseFirst();
    await Promise.all([first, second]);
    expect(
      session.inspectClaims("/openwiki/page.md").map(({ id }) => id),
    ).toEqual(["claim_1", "claim_2"]);
  });

  test("persists only dirty claim pages and refreshes their page hash", async () => {
    const page = "/openwiki/page.md";
    await writePage(page);
    const store = new ClaimsStore(rootDir);
    const session = createSession();
    const writeSidecar = vi.spyOn(store, "writePage");

    await session.finalize(store, VERIFICATION);
    expect(writeSidecar).not.toHaveBeenCalled();

    await session.resolveClaims({
      page,
      operations: [{ op: "confirm", id: "claim_existing" }],
    });
    await session.finalize(store, VERIFICATION);
    expect(writeSidecar).toHaveBeenCalledTimes(1);
    expect((await store.loadPage(page))?.claims[0]?.evidence[0]?.version).toBe(
      "revision:2",
    );
    expect((await store.loadPage(page))?.pageVersion).toBe(
      await store.hashPage(page),
    );
    expect((await store.loadPage(page))?.verification).toEqual(VERIFICATION);
  });

  test("does not create verification from a clean preflight", async () => {
    const page = "/openwiki/page.md";
    await writePage(page);
    const store = new ClaimsStore(rootDir);
    const session = createSession();

    const result = await session.finalize(store, VERIFICATION);

    expect(result.verificationByPage.get(page)).toBeNull();
    expect(await store.loadPage(page)).toBeNull();
  });

  test("retains a prior durable verification without advancing it", async () => {
    const page = "/openwiki/page.md";
    const prior = {
      by: "openwiki/0.3.2",
      at: "2026-08-19T12:00:00.000Z",
    };
    const session = new ClaimSession({
      resolver: createResolver(new Map()),
      persisted: new Map([
        [page, { ...persisted([CLAIM]), verification: prior }],
      ]),
      issues: [],
      orphanPages: [],
    });

    const result = await session.finalize(
      new ClaimsStore(rootDir),
      VERIFICATION,
    );

    expect(result.verificationByPage.get(page)).toEqual(prior);
  });

  test("withholds verification while any preflight debt remains", async () => {
    const page = "/openwiki/page.md";
    const session = createSession({
      issues: [
        {
          page,
          kind: "stale",
          claimId: "claim_existing",
          resources: ["memory://feature"],
        },
      ],
    });

    const result = await session.finalize(
      new ClaimsStore(rootDir),
      VERIFICATION,
    );

    expect(result.verificationByPage.get(page)).toBeNull();
  });

  test("does not expose a new event when sidecar persistence fails", async () => {
    const page = "/openwiki/page.md";
    await writePage(page);
    const store = new ClaimsStore(rootDir);
    const session = createSession();
    await session.resolveClaims({
      page,
      operations: [{ op: "confirm", id: "claim_existing" }],
    });
    vi.spyOn(store, "writePage").mockRejectedValueOnce(
      new ClaimsPersistenceError("disk unavailable"),
    );

    const result = await session.finalize(store, VERIFICATION);

    expect(result.warnings).toHaveLength(1);
    expect(result.verificationByPage.get(page)).toBeNull();
  });

  test("removes durable verification when reconciliation leaves no Claims", async () => {
    const page = "/openwiki/page.md";
    await writePage(page);
    const store = new ClaimsStore(rootDir);
    const session = new ClaimSession({
      resolver: createResolver(new Map()),
      persisted: new Map([
        [page, { ...persisted([CLAIM]), verification: { ...VERIFICATION } }],
      ]),
      issues: [],
      orphanPages: [],
    });
    await session.resolveClaims({
      page,
      operations: [{ op: "retract", id: "claim_existing" }],
    });

    const result = await session.finalize(store, {
      ...VERIFICATION,
      at: "2026-08-20T13:00:00.000Z",
    });

    expect(result.verificationByPage.get(page)).toBeNull();
    expect((await store.loadPage(page))?.verification).toBeUndefined();
  });

  test("page deletion removes a non-empty sidecar without retractions", async () => {
    const page = "/openwiki/page.md";
    const store = new ClaimsStore(rootDir);
    await store.writePage(page, persisted([CLAIM]));
    const session = createSession();

    await session.recordDeletion(page);
    await session.finalize(store, VERIFICATION);
    await expect(store.loadPage(page)).resolves.toBeNull();
  });

  test("removes orphan sidecars without dirty claim pages", async () => {
    const orphan = "/openwiki/orphan.md";
    const store = new ClaimsStore(rootDir);
    await store.writePage(orphan, persisted([]));
    const session = createSession({ orphanPages: [orphan] });

    await session.finalize(store, VERIFICATION);
    await expect(store.loadPage(orphan)).resolves.toBeNull();
  });

  test.each([
    ["disappears", null, "Evidence disappeared"],
    ["changes", resolved("memory://bad", "revision:3"), "Evidence changed"],
  ])(
    "isolates one page when its evidence %s before finalization",
    async (_condition, finalOutcome, expected) => {
      const badPage = "/openwiki/bad.md";
      const goodPage = "/openwiki/good.md";
      const orphan = "/openwiki/orphan.md";
      await writePage(badPage);
      await writePage(goodPage);
      const store = new ClaimsStore(rootDir);
      const badClaim: Claim = {
        id: "claim_bad",
        statement: "Bad evidence may change.",
        evidence: [{ resource: "memory://bad", version: "revision:1" }],
      };
      const goodClaim: Claim = {
        id: "claim_good",
        statement: "Good evidence remains current.",
        evidence: [{ resource: "memory://good", version: "revision:1" }],
      };
      await store.writePage(badPage, persisted([badClaim]));
      await store.writePage(goodPage, persisted([goodClaim]));
      await store.writePage(orphan, persisted([]));
      const outcomes = new Map<string, ResolvedEvidence | null>([
        ["memory://bad", resolved("memory://bad", "revision:2")],
        ["memory://good", resolved("memory://good", "revision:2")],
      ]);
      const session = new ClaimSession({
        resolver: createResolver(outcomes),
        persisted: new Map([
          [badPage, persisted([badClaim])],
          [goodPage, persisted([goodClaim])],
        ]),
        issues: [],
        orphanPages: [orphan],
      });
      await session.resolveClaims({
        page: badPage,
        operations: [{ op: "confirm", id: "claim_bad" }],
      });
      await session.resolveClaims({
        page: goodPage,
        operations: [{ op: "confirm", id: "claim_good" }],
      });
      outcomes.set("memory://bad", finalOutcome);

      const result = await session.finalize(store, VERIFICATION);

      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain(expected);
      expect(
        (await store.loadPage(badPage))?.claims[0]?.evidence[0]?.version,
      ).toBe("revision:1");
      expect(
        (await store.loadPage(goodPage))?.claims[0]?.evidence[0]?.version,
      ).toBe("revision:2");
      await expect(store.loadPage(orphan)).resolves.toBeNull();
    },
  );

  test("keeps unsafe finalization paths fatal", async () => {
    const page = "/openwiki/page.md";
    await writePage(page);
    const store = new ClaimsStore(rootDir);
    const session = createSession();
    await session.resolveClaims({
      page,
      operations: [{ op: "confirm", id: "claim_existing" }],
    });
    vi.spyOn(store, "hashPage").mockRejectedValueOnce(
      new ClaimsPersistenceSecurityError("unsafe claims path"),
    );

    await expect(session.finalize(store, VERIFICATION)).rejects.toThrow(
      "unsafe claims path",
    );
  });

  test("removes a sidecar when its dirty Markdown page disappeared", async () => {
    const page = "/openwiki/page.md";
    const store = new ClaimsStore(rootDir);
    await store.writePage(page, persisted([CLAIM]));
    const session = createSession();
    await session.resolveClaims({
      page,
      operations: [{ op: "confirm", id: "claim_existing" }],
    });

    const result = await session.finalize(store, VERIFICATION);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Markdown disappeared");
    await expect(store.loadPage(page)).resolves.toBeNull();
  });

  test("shares evidence resolution across dirty pages during finalization", async () => {
    const resource = "memory://feature";
    const calls: string[] = [];
    const resolver = createResolver(
      new Map([[resource, resolved(resource, "revision:2")]]),
      calls,
    );
    const pages = ["/openwiki/a.md", "/openwiki/b.md"];
    for (const page of pages) await writePage(page);
    const session = new ClaimSession({
      resolver,
      persisted: new Map(
        pages.map((page, index) => [
          page,
          persisted([{ ...CLAIM, id: `claim_${index}` }]),
        ]),
      ),
      issues: [],
      orphanPages: [],
    });
    for (const [index, page] of pages.entries()) {
      await session.resolveClaims({
        page,
        operations: [{ op: "confirm", id: `claim_${index}` }],
      });
    }
    calls.length = 0;
    await session.finalize(new ClaimsStore(rootDir), VERIFICATION);
    expect(calls).toEqual([resource]);
  });
});
