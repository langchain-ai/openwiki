import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runClaimsPreflight } from "../../../../src/claims/brains/code/preflight.ts";
import { ClaimsStore } from "../../../../src/claims/brains/code/store.ts";
import { CODE_CLAIMS_SCHEMA_VERSION } from "../../../../src/claims/brains/code/types.ts";
import type { PageClaims } from "../../../../src/claims/brains/code/types.ts";
import type {
  EvidenceResolver,
  ResolvedEvidence,
} from "../../../../src/claims/core/types.ts";

/**
 * Creates current resolved evidence for a fixture resource and version.
 *
 * @param resource - Stable evidence identity.
 * @param version - Current opaque evidence version.
 * @returns Current resolved evidence.
 */
function resolvedEvidence(resource: string, version: string): ResolvedEvidence {
  return {
    evidence: { resource, version },
    content: `content for ${resource}`,
  };
}

describe("runClaimsPreflight", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "openwiki-preflight-"));
  });

  afterEach(async () => {
    await rm(rootDir, { force: true, recursive: true });
  });

  /**
   * Writes a generated Markdown fixture.
   *
   * @param page - Virtual generated-page path.
   * @param content - Complete Markdown contents.
   */
  async function writePage(page: string, content: string): Promise<void> {
    const relative = page.replace(/^\/+/u, "");
    const absolute = path.join(rootDir, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }

  /**
   * Creates valid sidecar state for the current page bytes.
   *
   * @param store - Claims persistence used to hash the page.
   * @param page - Virtual generated-page path.
   * @param claims - Persisted claims for the page.
   * @returns Valid synchronized page state.
   */
  async function pageClaims(
    store: ClaimsStore,
    page: string,
    claims: PageClaims["claims"],
  ): Promise<PageClaims> {
    return {
      schemaVersion: CODE_CLAIMS_SCHEMA_VERSION,
      pageVersion: await store.hashPage(page),
      claims,
    };
  }

  /**
   * Creates a deterministic resolver backed by fixture outcomes.
   *
   * @param outcomes - Current outcome keyed by evidence resource.
   * @param calls - Optional call counter keyed by evidence resource.
   * @returns Evidence resolver for preflight tests.
   */
  function createResolver(
    outcomes: ReadonlyMap<string, ResolvedEvidence | null | Error>,
    calls?: Map<string, number>,
  ): EvidenceResolver {
    return {
      resolve(resource: string): Promise<ResolvedEvidence | null> {
        calls?.set(resource, (calls.get(resource) ?? 0) + 1);
        const outcome = outcomes.get(resource);
        if (outcome instanceof Error) {
          return Promise.reject(outcome);
        }
        return Promise.resolve(outcome ?? null);
      },
    };
  }

  test("does not turn pages without sidecars into mandatory work", async () => {
    await writePage("/openwiki/quickstart.md", "# Quickstart\n");
    const store = new ClaimsStore(rootDir);

    const result = await runClaimsPreflight(store, createResolver(new Map()));

    expect(result.issues).toEqual([]);
    expect(result.persisted.size).toBe(0);
  });

  test("ignores page hash drift", async () => {
    const page = "/openwiki/page.md";
    await writePage(page, "# Page\n");
    const store = new ClaimsStore(rootDir);
    await store.writePage(page, await pageClaims(store, page, []));

    const synchronized = await runClaimsPreflight(
      store,
      createResolver(new Map()),
    );
    await writePage(page, "# Page changed\n");
    const changed = await runClaimsPreflight(store, createResolver(new Map()));

    expect(synchronized.issues).toEqual([]);
    expect(changed.issues).toEqual([]);
  });

  test("classifies stale and unresolved claims with unresolved precedence", async () => {
    const page = "/openwiki/page.md";
    const staleResource = "repo://src/stale.ts#L10-L20";
    const staleFileResource = "repo://src/stale-file.ts";
    const missingResource = "repo://src/missing.ts#L10-L20";
    await writePage(page, "# Page\n");
    const store = new ClaimsStore(rootDir);
    await store.writePage(
      page,
      await pageClaims(store, page, [
        {
          id: "claim_stale",
          statement: "A stale fact.",
          evidence: [{ resource: staleResource, version: "old" }],
        },
        {
          id: "claim_stale_file",
          statement: "A stale file-backed fact.",
          evidence: [{ resource: staleFileResource, version: "old" }],
        },
        {
          id: "claim_unresolved",
          statement: "A partially unresolved fact.",
          evidence: [
            { resource: staleResource, version: "old" },
            { resource: missingResource, version: "old" },
          ],
        },
      ]),
    );
    const calls = new Map<string, number>();
    const resolver = createResolver(
      new Map([
        [staleResource, resolvedEvidence(staleResource, "new")],
        [staleFileResource, resolvedEvidence(staleFileResource, "new")],
        [missingResource, null],
      ]),
      calls,
    );

    const result = await runClaimsPreflight(store, resolver);

    expect(result.issues).toEqual([
      {
        page,
        kind: "stale",
        claimId: "claim_stale",
        resources: [staleResource],
      },
      {
        page,
        kind: "stale",
        claimId: "claim_stale_file",
        resources: [staleFileResource],
      },
      {
        page,
        kind: "unresolved",
        claimId: "claim_unresolved",
        resources: [missingResource],
      },
    ]);
    expect(calls).toEqual(
      new Map([
        [staleResource, 1],
        [staleFileResource, 1],
        [missingResource, 1],
      ]),
    );
  });

  test("resolves shared resources separately when their prior versions differ", async () => {
    const page = "/openwiki/page.md";
    const resource = "repo://src/shared.ts#L1-L2";
    await writePage(page, "# Page\n");
    const store = new ClaimsStore(rootDir);
    await store.writePage(
      page,
      await pageClaims(store, page, [
        {
          id: "claim_first",
          statement: "The first fact.",
          evidence: [{ resource, version: "anchor:first" }],
        },
        {
          id: "claim_second",
          statement: "The second fact.",
          evidence: [{ resource, version: "anchor:second" }],
        },
      ]),
    );
    const versions: Array<string | undefined> = [];
    const resolver: EvidenceResolver = {
      resolve(resourceInput, previousVersion) {
        versions.push(previousVersion);
        return Promise.resolve(
          resolvedEvidence(resourceInput, previousVersion ?? "missing"),
        );
      },
    };

    const result = await runClaimsPreflight(store, resolver);

    expect(result.issues).toEqual([]);
    expect(versions).toEqual(["anchor:first", "anchor:second"]);
  });

  test("propagates resolver failures instead of treating them as unresolved", async () => {
    const page = "/openwiki/page.md";
    const resource = "repo://src/broken.ts#L10-L20";
    await writePage(page, "# Page\n");
    const store = new ClaimsStore(rootDir);
    await store.writePage(
      page,
      await pageClaims(store, page, [
        {
          id: "claim_broken",
          statement: "A fact.",
          evidence: [{ resource, version: "old" }],
        },
      ]),
    );
    const failure = new Error("evidence unavailable");

    await expect(
      runClaimsPreflight(store, createResolver(new Map([[resource, failure]]))),
    ).rejects.toBe(failure);
  });

  test("inventories orphan sidecars without deleting them", async () => {
    const currentPage = "/openwiki/current.md";
    const orphanPage = "/openwiki/removed.md";
    await writePage(currentPage, "# Current\n");
    const store = new ClaimsStore(rootDir);
    await store.writePage(
      currentPage,
      await pageClaims(store, currentPage, []),
    );
    await store.writePage(orphanPage, {
      schemaVersion: 1,
      pageVersion: `sha256:${"f".repeat(64)}`,
      claims: [],
    });

    const result = await runClaimsPreflight(store, createResolver(new Map()));

    expect(result.orphanPages).toEqual([orphanPage]);
    await expect(store.loadPage(orphanPage)).resolves.not.toBeNull();
  });

  test("classifies a page rename only as an orphan sidecar", async () => {
    const oldPage = "/openwiki/old-name.md";
    const newPage = "/openwiki/new-name.md";
    await writePage(newPage, "# Renamed\n");
    const store = new ClaimsStore(rootDir);
    await store.writePage(oldPage, {
      schemaVersion: 1,
      pageVersion: `sha256:${"f".repeat(64)}`,
      claims: [],
    });

    const result = await runClaimsPreflight(store, createResolver(new Map()));

    expect(result.issues).toEqual([]);
    expect(result.orphanPages).toEqual([oldPage]);
    await expect(store.loadPage(oldPage)).resolves.not.toBeNull();
  });

  test("returns issues in stable page, kind, and claim order", async () => {
    const alpha = "/openwiki/alpha.md";
    const zeta = "/openwiki/zeta.md";
    const zetaResource = "repo://src/zeta.ts#L10-L20";
    await writePage(zeta, "# Zeta\n");
    await writePage(alpha, "# Alpha\n");
    const store = new ClaimsStore(rootDir);
    await store.writePage(
      zeta,
      await pageClaims(store, zeta, [
        {
          id: "claim_zeta",
          statement: "A fact.",
          evidence: [{ resource: zetaResource, version: "old" }],
        },
      ]),
    );
    await writePage(zeta, "# Zeta changed\n");

    const result = await runClaimsPreflight(
      store,
      createResolver(
        new Map([[zetaResource, resolvedEvidence(zetaResource, "new")]]),
      ),
    );

    expect(result.issues).toEqual([
      {
        page: zeta,
        kind: "stale",
        claimId: "claim_zeta",
        resources: [zetaResource],
      },
    ]);
  });
});
