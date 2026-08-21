import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ClaimsStore } from "../../../../src/claims/brains/code/store.ts";
import { CODE_CLAIMS_SCHEMA_VERSION } from "../../../../src/claims/brains/code/types.ts";
import type { PageClaims } from "../../../../src/claims/brains/code/types.ts";
import {
  ClaimsPersistenceError,
  ClaimsPersistenceSecurityError,
} from "../../../../src/claims/core/errors.ts";

/**
 * Valid deterministic page hash used by validation fixtures.
 */
const VALID_PAGE_VERSION = `sha256:${"a".repeat(64)}`;

describe("ClaimsStore", () => {
  let rootDir: string;
  let cleanupDirectories: string[];

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "openwiki-claims-store-"));
    cleanupDirectories = [rootDir];
  });

  afterEach(async () => {
    await Promise.all(
      cleanupDirectories.map((directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
    );
  });

  /**
   * Writes a repository fixture and creates its parent directories.
   *
   * @param relativePath - Repository-relative fixture path.
   * @param content - Complete fixture contents.
   */
  async function writeFixture(
    relativePath: string,
    content: string,
  ): Promise<void> {
    const absolutePath = path.join(rootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }

  /**
   * Creates valid persisted page state for one page.
   *
   * @param store - Store used to hash the current page.
   * @param page - Virtual generated-page path.
   * @returns Valid sidecar state with one claim.
   */
  async function createPageClaims(
    store: ClaimsStore,
    page: string,
  ): Promise<PageClaims> {
    return {
      schemaVersion: CODE_CLAIMS_SCHEMA_VERSION,
      pageVersion: await store.hashPage(page),
      claims: [
        {
          id: "claim_fixture",
          statement: "The fixture is enabled.",
          evidence: [
            {
              resource: "repo://src/fixture.ts#L1-L4",
              version: "repo-lines-v1:sha256:fixture",
            },
          ],
        },
      ],
    };
  }

  test("discovers grounded pages while excluding structural files and symlinks", async () => {
    await writeFixture("openwiki/quickstart.md", "# Quickstart\n");
    await writeFixture("openwiki/concepts/claims.md", "# Claims\n");
    await writeFixture("openwiki/index.md", "# Index\n");
    await writeFixture("openwiki/nested/INSTRUCTIONS.md", "# Internal\n");
    await writeFixture("openwiki/nested/.claims/hidden.md", "# Hidden\n");
    await writeFixture("openwiki/other/.CLAIMS/hidden.md", "# Hidden\n");
    await writeFixture("openwiki/notes.txt", "not markdown\n");
    await writeFixture("linked.md", "# Linked\n");
    await symlink(
      path.join(rootDir, "linked.md"),
      path.join(rootDir, "openwiki", "linked.md"),
    );
    const linkedDirectory = await mkdtemp(
      path.join(tmpdir(), "openwiki-claims-linked-"),
    );
    cleanupDirectories.push(linkedDirectory);
    await writeFile(path.join(linkedDirectory, "outside.md"), "# Outside\n");
    await symlink(
      linkedDirectory,
      path.join(rootDir, "openwiki", "linked-directory"),
      "dir",
    );

    const store = new ClaimsStore(rootDir);

    await expect(store.discoverPages()).resolves.toEqual([
      "/openwiki/concepts/claims.md",
      "/openwiki/quickstart.md",
    ]);
  });

  test("round-trips stable pretty JSON through atomic writes", async () => {
    await writeFixture("openwiki/concepts/claims.md", "# Claims\n");
    const store = new ClaimsStore(rootDir);
    const page = "/openwiki/concepts/claims.md";
    const pageClaims = await createPageClaims(store, page);
    pageClaims.verification = {
      by: "openwiki/0.3.3",
      at: "2026-08-20T12:00:00.000Z",
    };

    await store.writePage(page, pageClaims);

    const sidecarPath = path.join(
      rootDir,
      "openwiki/.claims/concepts/claims.json",
    );
    await expect(readFile(sidecarPath, "utf8")).resolves.toBe(
      `${JSON.stringify(pageClaims, null, 2)}\n`,
    );
    await expect(store.loadPage(page)).resolves.toEqual(pageClaims);
    await expect(store.discoverSidecarPages()).resolves.toEqual([page]);
    await expect(readdir(path.dirname(sidecarPath))).resolves.toEqual([
      "claims.json",
    ]);
  });

  test("deletes sidecars idempotently", async () => {
    await writeFixture("openwiki/page.md", "# Page\n");
    const store = new ClaimsStore(rootDir);
    const page = "/openwiki/page.md";
    await store.writePage(page, await createPageClaims(store, page));

    await store.deletePage(page);
    await store.deletePage(page);

    await expect(store.loadPage(page)).resolves.toBeNull();
  });

  test("returns empty discovery and missing state for a repository without a wiki", async () => {
    const store = new ClaimsStore(rootDir);

    await expect(store.discoverPages()).resolves.toEqual([]);
    await expect(store.discoverSidecarPages()).resolves.toEqual([]);
    await expect(store.loadPage("/openwiki/missing.md")).resolves.toBeNull();
  });

  test("fails closed for malformed and invalid persisted sidecars", async () => {
    const sidecarPath = path.join(rootDir, "openwiki/.claims/page.json");
    await mkdir(path.dirname(sidecarPath), { recursive: true });
    const store = new ClaimsStore(rootDir);

    await writeFile(sidecarPath, "{not json", "utf8");
    await expect(store.loadPage("/openwiki/page.md")).rejects.toThrow(
      "openwiki/.claims/page.json",
    );

    const invalidValues: unknown[] = [
      { schemaVersion: 2, pageVersion: VALID_PAGE_VERSION, claims: [] },
      { schemaVersion: 1, pageVersion: "sha256:bad", claims: [] },
      {
        schemaVersion: 1,
        pageVersion: VALID_PAGE_VERSION,
        claims: [{ id: "claim_empty", statement: "Fact", evidence: [] }],
      },
      {
        schemaVersion: 1,
        pageVersion: VALID_PAGE_VERSION,
        claims: [
          {
            id: "claim_duplicate",
            statement: "First",
            evidence: [{ resource: "repo://one", version: "v1" }],
          },
          {
            id: "claim_duplicate",
            statement: "Second",
            evidence: [{ resource: "repo://two", version: "v1" }],
          },
        ],
      },
      {
        schemaVersion: 1,
        pageVersion: VALID_PAGE_VERSION,
        claims: [
          {
            id: "claim_evidence",
            statement: "Fact",
            evidence: [
              { resource: "repo://same", version: "v1" },
              { resource: "repo://same", version: "v1" },
            ],
          },
        ],
      },
      {
        schemaVersion: 1,
        pageVersion: VALID_PAGE_VERSION,
        claims: [],
        unknown: true,
      },
      {
        schemaVersion: 1,
        pageVersion: VALID_PAGE_VERSION,
        claims: [],
        verification: { by: "", at: "2026-08-20T12:00:00.000Z" },
      },
      {
        schemaVersion: 1,
        pageVersion: VALID_PAGE_VERSION,
        claims: [],
        verification: { by: "openwiki/0.3.3" },
      },
    ];

    for (const invalid of invalidValues) {
      await writeFile(sidecarPath, JSON.stringify(invalid), "utf8");
      await expect(store.loadPage("/openwiki/page.md")).rejects.toThrow(
        ClaimsPersistenceError,
      );
    }
  });

  test("refuses to write duplicate claim and evidence identities", async () => {
    const store = new ClaimsStore(rootDir);
    const initial: PageClaims = {
      schemaVersion: 1,
      pageVersion: VALID_PAGE_VERSION,
      claims: [],
    };
    const duplicateIds: PageClaims = {
      schemaVersion: 1,
      pageVersion: VALID_PAGE_VERSION,
      claims: [
        {
          id: "claim_same",
          statement: "First",
          evidence: [{ resource: "repo://one", version: "v1" }],
        },
        {
          id: "claim_same",
          statement: "Second",
          evidence: [{ resource: "repo://two", version: "v1" }],
        },
      ],
    };
    const duplicateEvidence: PageClaims = {
      schemaVersion: 1,
      pageVersion: VALID_PAGE_VERSION,
      claims: [
        {
          id: "claim_one",
          statement: "Fact",
          evidence: [
            { resource: "repo://same", version: "v1" },
            { resource: "repo://same", version: "v1" },
          ],
        },
      ],
    };
    const invalidHash: PageClaims = {
      schemaVersion: 1,
      pageVersion: "sha256:bad",
      claims: [],
    };
    const emptyEvidence: PageClaims = {
      schemaVersion: 1,
      pageVersion: VALID_PAGE_VERSION,
      claims: [
        {
          id: "claim_empty",
          statement: "Fact",
          evidence: [],
        },
      ],
    };

    await store.writePage("/openwiki/page.md", initial);
    await expect(
      store.writePage("/openwiki/page.md", duplicateIds),
    ).rejects.toThrow(ClaimsPersistenceError);
    await expect(
      store.writePage("/openwiki/page.md", duplicateEvidence),
    ).rejects.toThrow(ClaimsPersistenceError);
    await expect(
      store.writePage("/openwiki/page.md", invalidHash),
    ).rejects.toThrow(ClaimsPersistenceError);
    await expect(
      store.writePage("/openwiki/page.md", emptyEvidence),
    ).rejects.toThrow(ClaimsPersistenceError);
    await expect(store.loadPage("/openwiki/page.md")).resolves.toEqual(initial);
  });

  test("hashes exact Markdown bytes", async () => {
    await writeFixture("openwiki/page.md", "# Page\n");
    const store = new ClaimsStore(rootDir);
    const before = await store.hashPage("/openwiki/page.md");

    await writeFixture("openwiki/page.md", "# Page\n\n");
    const after = await store.hashPage("/openwiki/page.md");

    expect(before).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(after).not.toBe(before);
  });

  test("rejects symlinked sidecars and parent directories", async () => {
    await writeFixture("openwiki/page.md", "# Page\n");
    const outsideDir = await mkdtemp(
      path.join(tmpdir(), "openwiki-claims-outside-"),
    );
    cleanupDirectories.push(outsideDir);
    await symlink(outsideDir, path.join(rootDir, "openwiki", ".claims"), "dir");
    const store = new ClaimsStore(rootDir);
    const pageClaims = await createPageClaims(store, "/openwiki/page.md");

    await expect(
      store.writePage("/openwiki/page.md", pageClaims),
    ).rejects.toThrow(ClaimsPersistenceSecurityError);
    await expect(readdir(outsideDir)).resolves.toEqual([]);
  });

  test("rejects symlinked Markdown and sidecar files", async () => {
    await mkdir(path.join(rootDir, "openwiki/.claims"), { recursive: true });
    await writeFixture("outside.md", "# Outside\n");
    await symlink(
      path.join(rootDir, "outside.md"),
      path.join(rootDir, "openwiki/page.md"),
    );
    await writeFixture("sidecar.json", "{}\n");
    await symlink(
      path.join(rootDir, "sidecar.json"),
      path.join(rootDir, "openwiki/.claims/page.json"),
    );
    const store = new ClaimsStore(rootDir);

    await expect(store.hashPage("/openwiki/page.md")).rejects.toThrow(
      ClaimsPersistenceSecurityError,
    );
    await expect(store.loadPage("/openwiki/page.md")).rejects.toThrow(
      ClaimsPersistenceSecurityError,
    );
  });

  test("requires an absolute repository root", () => {
    expect(() => new ClaimsStore("relative/repository")).toThrow(
      ClaimsPersistenceError,
    );
  });
});
