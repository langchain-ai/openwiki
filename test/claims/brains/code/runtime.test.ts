import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { OpenWikiIgnore } from "../../../../src/agent/openwiki-ignore.ts";
import { prepareClaimsRuntime } from "../../../../src/claims/brains/code/runtime.ts";
import { ClaimsStore } from "../../../../src/claims/brains/code/store.ts";
import { ClaimsPersistenceError } from "../../../../src/claims/core/errors.ts";
import {
  parseFrontmatterFields,
  setOkfVerified,
} from "../../../../src/okf/frontmatter.ts";
import { OPENWIKI_PRODUCER_ACTOR } from "../../../../src/version.ts";

describe("prepareClaimsRuntime", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "openwiki-runtime-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(rootDir, { force: true, recursive: true });
  });

  /**
   * Writes one generated Markdown page.
   *
   * @param page - Virtual generated-page path.
   * @param content - Complete Markdown contents.
   */
  async function writePage(page: string, content: string): Promise<void> {
    const absolute = path.join(rootDir, page.replace(/^\/+/u, ""));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }

  /**
   * Reads one generated Markdown page.
   *
   * @param page - Virtual generated-page path.
   * @returns Complete UTF-8 Markdown contents.
   */
  async function readPage(page: string): Promise<string> {
    return readFile(path.join(rootDir, page.replace(/^\/+/, "")), "utf8");
  }

  test("disables Claims for chat and personal-brain runs", async () => {
    const ignore = new OpenWikiIgnore([]);

    await expect(
      prepareClaimsRuntime("chat", "repository", rootDir, ignore),
    ).resolves.toBeUndefined();
    await expect(
      prepareClaimsRuntime("init", "local-wiki", rootDir, ignore),
    ).resolves.toBeUndefined();
    await expect(
      prepareClaimsRuntime("update", "local-wiki", rootDir, ignore),
    ).resolves.toBeUndefined();
  });

  test("starts init with empty working state and inventories old sidecars", async () => {
    const orphanPage = "/openwiki/old.md";
    const store = new ClaimsStore(rootDir);
    await store.writePage(orphanPage, {
      schemaVersion: 1,
      pageVersion: `sha256:${"a".repeat(64)}`,
      claims: [],
    });

    const runtime = await prepareClaimsRuntime(
      "init",
      "repository",
      rootDir,
      new OpenWikiIgnore([]),
    );

    expect(runtime?.issueCount).toBe(0);
    expect(runtime?.issues).toEqual([]);
    expect(runtime?.session.inspectClaims(orphanPage)).toEqual([]);
    await runtime?.finalize();
    await expect(store.loadPage(orphanPage)).resolves.toBeNull();
  });

  test("does not turn pages without sidecars into mandatory or lazy work", async () => {
    const page = "/openwiki/page.md";
    await writePage(page, "# Page\n");
    const store = new ClaimsStore(rootDir);

    const runtime = await prepareClaimsRuntime(
      "update",
      "repository",
      rootDir,
      new OpenWikiIgnore([]),
    );

    expect(runtime?.issueCount).toBe(0);
    expect(runtime?.session.inspectClaims(page)).toEqual([]);
    await runtime?.finalize();
    await expect(store.loadPage(page)).resolves.toBeNull();
  });

  test("loads synchronized persisted claims into update working state", async () => {
    const page = "/openwiki/page.md";
    await writePage(page, "# Page\n");
    const store = new ClaimsStore(rootDir);
    const pageClaims = {
      schemaVersion: 1 as const,
      pageVersion: await store.hashPage(page),
      claims: [
        {
          id: "claim_existing",
          statement: "The page exists.",
          evidence: [
            {
              resource: "repo://package.json",
              version: "repo-file-v1:sha256:old",
            },
          ],
        },
      ],
    };
    await store.writePage(page, pageClaims);

    const runtime = await prepareClaimsRuntime(
      "update",
      "repository",
      rootDir,
      new OpenWikiIgnore([]),
    );

    expect(runtime?.issueCount).toBe(1);
    expect(runtime?.session.inspectClaims(page)).toEqual([
      {
        id: "claim_existing",
        statement: "The page exists.",
        evidence: ["repo://package.json"],
        issue: {
          kind: "unresolved",
          resources: ["repo://package.json"],
        },
      },
    ]);
  });

  test("reports zero lazy issues for fresh persisted Claims", async () => {
    const page = "/openwiki/page.md";
    await writePage(page, "# Page\n");
    const store = new ClaimsStore(rootDir);
    await store.writePage(page, {
      schemaVersion: 1,
      pageVersion: await store.hashPage(page),
      claims: [],
    });

    const runtime = await prepareClaimsRuntime(
      "update",
      "repository",
      rootDir,
      new OpenWikiIgnore([]),
    );

    expect(runtime?.issueCount).toBe(0);
    await runtime?.finalize("2026-08-20T12:00:00.000Z");
    expect(
      parseFrontmatterFields(await readPage(page))?.verified,
    ).toBeUndefined();
  });

  test("stamps only an actively reconciled page and keeps its final hash synchronized", async () => {
    const page = "/openwiki/page.md";
    await writePage(
      page,
      "---\ntype: Reference\ngenerated: {by: openwiki/0.3.2, at: 2026-08-19T12:00:00.000Z}\n---\n\n# Page\n",
    );
    await writeFile(
      path.join(rootDir, "source.ts"),
      "export const value = 1;\n",
    );
    const runtime = await prepareClaimsRuntime(
      "init",
      "repository",
      rootDir,
      new OpenWikiIgnore([]),
    );
    await runtime?.session.resolveClaims({
      page,
      operations: [
        {
          op: "add",
          statement: "The source exports a value.",
          evidence: [{ resource: "repo://source.ts" }],
        },
      ],
    });

    await runtime?.finalize("2026-08-20T12:00:00.000Z");

    const content = await readPage(page);
    expect(parseFrontmatterFields(content)?.verified).toEqual([
      {
        by: OPENWIKI_PRODUCER_ACTOR,
        at: "2026-08-20T12:00:00.000Z",
      },
    ]);
    expect(parseFrontmatterFields(content)?.generated).toEqual({
      by: "openwiki/0.3.2",
      at: "2026-08-19T12:00:00.000Z",
    });
    const store = new ClaimsStore(rootDir);
    expect((await store.loadPage(page))?.verification).toEqual({
      by: OPENWIKI_PRODUCER_ACTOR,
      at: "2026-08-20T12:00:00.000Z",
    });
    expect((await store.loadPage(page))?.pageVersion).toBe(
      await store.hashPage(page),
    );

    await writePage(page, setOkfVerified(content, []));
    const retry = await prepareClaimsRuntime(
      "update",
      "repository",
      rootDir,
      new OpenWikiIgnore([]),
    );
    await retry?.finalize("2026-08-20T12:30:00.000Z");
    expect(parseFrontmatterFields(await readPage(page))?.verified).toEqual([
      {
        by: OPENWIKI_PRODUCER_ACTOR,
        at: "2026-08-20T12:00:00.000Z",
      },
    ]);
  });

  test("clean preflight preserves the prior event while debt removes only OpenWiki's event", async () => {
    const page = "/openwiki/page.md";
    await writePage(page, "---\ntype: Reference\n---\n\n# Page\n");
    await writeFile(
      path.join(rootDir, "source.ts"),
      "export const value = 1;\n",
    );
    const initial = await prepareClaimsRuntime(
      "init",
      "repository",
      rootDir,
      new OpenWikiIgnore([]),
    );
    await initial?.session.resolveClaims({
      page,
      operations: [
        {
          op: "add",
          statement: "The source exports a value.",
          evidence: [{ resource: "repo://source.ts" }],
        },
      ],
    });
    await initial?.finalize("2026-08-20T10:00:00.000Z");

    const clean = await prepareClaimsRuntime(
      "update",
      "repository",
      rootDir,
      new OpenWikiIgnore([]),
    );
    await clean?.finalize("2026-08-20T11:00:00.000Z");
    expect(parseFrontmatterFields(await readPage(page))?.verified).toEqual([
      {
        by: OPENWIKI_PRODUCER_ACTOR,
        at: "2026-08-20T10:00:00.000Z",
      },
    ]);

    const withHuman = setOkfVerified(await readPage(page), [
      { by: "human:reviewer", at: "2026-08-20T11:30:00.000Z" },
      {
        by: OPENWIKI_PRODUCER_ACTOR,
        at: "2026-08-20T10:00:00.000Z",
      },
    ]);
    await writePage(page, withHuman);
    await writeFile(
      path.join(rootDir, "source.ts"),
      "export const value = 2;\n",
    );
    const debt = await prepareClaimsRuntime(
      "update",
      "repository",
      rootDir,
      new OpenWikiIgnore([]),
    );
    expect(debt?.issueCount).toBe(1);

    await debt?.finalize("2026-08-20T12:00:00.000Z");

    expect(parseFrontmatterFields(await readPage(page))?.verified).toEqual([
      { by: "human:reviewer", at: "2026-08-20T11:30:00.000Z" },
    ]);
    const store = new ClaimsStore(rootDir);
    expect((await store.loadPage(page))?.pageVersion).toBe(
      await store.hashPage(page),
    );

    const reconciled = await prepareClaimsRuntime(
      "update",
      "repository",
      rootDir,
      new OpenWikiIgnore([]),
    );
    const claimId = reconciled?.session.inspectClaims(page)[0]?.id;
    expect(claimId).toBeDefined();
    await reconciled?.session.resolveClaims({
      page,
      operations: [{ op: "confirm", id: claimId! }],
    });
    await reconciled?.finalize("2026-08-20T13:00:00.000Z");

    expect(parseFrontmatterFields(await readPage(page))?.verified).toEqual([
      { by: "human:reviewer", at: "2026-08-20T11:30:00.000Z" },
      {
        by: OPENWIKI_PRODUCER_ACTOR,
        at: "2026-08-20T13:00:00.000Z",
      },
    ]);
  });

  test("loads persisted Claims when resuming an interrupted init", async () => {
    const page = "/openwiki/page.md";
    await writePage(page, "# Page\n");
    await writeFile(
      path.join(rootDir, "source.ts"),
      "export const value = 1;\n",
    );
    const store = new ClaimsStore(rootDir);
    await store.writePage(page, {
      schemaVersion: 1,
      pageVersion: await store.hashPage(page),
      claims: [
        {
          id: "claim_resumed",
          statement: "The source exports a value.",
          evidence: [
            {
              resource: "repo://source.ts",
              version: "repo-file-v1:sha256:outdated",
            },
          ],
        },
      ],
    });

    const runtime = await prepareClaimsRuntime(
      "init",
      "repository",
      rootDir,
      new OpenWikiIgnore([]),
      () => undefined,
      { resumeInit: true },
    );

    expect(runtime?.session.inspectClaims(page)).toEqual([
      {
        id: "claim_resumed",
        statement: "The source exports a value.",
        evidence: ["repo://source.ts"],
        issue: {
          kind: "stale",
          resources: ["repo://source.ts"],
        },
      },
    ]);
    expect(runtime?.issues).toEqual([
      {
        page,
        kind: "stale",
        claimId: "claim_resumed",
        resources: ["repo://source.ts"],
      },
    ]);
    expect(runtime?.issueCount).toBe(1);
  });

  test("rejects persistence warnings, notifies the sink, and supports retry", async () => {
    const page = "/openwiki/page.md";
    await writePage(page, "---\ntype: Reference\n---\n\n# Page\n");
    await writeFile(
      path.join(rootDir, "source.ts"),
      "export const value = 1;\n",
    );
    const warnings: string[] = [];
    const runtime = await prepareClaimsRuntime(
      "init",
      "repository",
      rootDir,
      new OpenWikiIgnore([]),
      (warning) => warnings.push(warning),
    );
    await runtime?.session.resolveClaims({
      page,
      operations: [
        {
          op: "add",
          statement: "The source exports a value.",
          evidence: [{ resource: "repo://source.ts" }],
        },
      ],
    });
    vi.spyOn(ClaimsStore.prototype, "writePage").mockRejectedValueOnce(
      new ClaimsPersistenceError("disk unavailable"),
    );

    await expect(runtime?.finalize("2026-08-20T12:00:00.000Z")).rejects.toThrow(
      ClaimsPersistenceError,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("persist Claims for /openwiki/page.md");

    await expect(
      runtime?.finalize("2026-08-20T12:30:00.000Z"),
    ).resolves.toBeUndefined();
    const store = new ClaimsStore(rootDir);
    expect((await store.loadPage(page))?.verification?.at).toBe(
      "2026-08-20T12:30:00.000Z",
    );
  });

  test("rejects verification projection failure and remains retryable", async () => {
    const page = "/openwiki/page.md";
    const content = setOkfVerified("---\ntype: Reference\n---\n\n# Page\n", [
      {
        by: OPENWIKI_PRODUCER_ACTOR,
        at: "2026-08-19T12:00:00.000Z",
      },
    ]);
    await writePage(page, content);
    const runtime = await prepareClaimsRuntime(
      "update",
      "repository",
      rootDir,
      new OpenWikiIgnore([]),
    );
    vi.spyOn(ClaimsStore.prototype, "writeMarkdown").mockRejectedValueOnce(
      new ClaimsPersistenceError("projection unavailable"),
    );

    await expect(runtime?.finalize()).rejects.toThrow("projection unavailable");
    expect(await readPage(page)).toBe(content);

    await expect(runtime?.finalize()).resolves.toBeUndefined();
    expect(
      parseFrontmatterFields(await readPage(page))?.verified,
    ).toBeUndefined();
  });

  test("rolls back verification when page-version refresh fails and resumes safely", async () => {
    const page = "/openwiki/page.md";
    const originalContent = "---\ntype: Reference\n---\n\n# Page\n";
    await writePage(page, originalContent);
    await writeFile(
      path.join(rootDir, "source.ts"),
      "export const value = 1;\n",
    );
    const runtime = await prepareClaimsRuntime(
      "init",
      "repository",
      rootDir,
      new OpenWikiIgnore([]),
    );
    await runtime?.session.resolveClaims({
      page,
      operations: [
        {
          op: "add",
          statement: "The source exports a value.",
          evidence: [{ resource: "repo://source.ts" }],
        },
      ],
    });

    const originalStore = new ClaimsStore(rootDir);
    const originalWritePage = originalStore.writePage.bind(originalStore);
    let writeCount = 0;
    const writeSpy = vi
      .spyOn(ClaimsStore.prototype, "writePage")
      .mockImplementation(async function (pageInput, state) {
        writeCount += 1;
        if (writeCount === 2) {
          throw new ClaimsPersistenceError("refresh unavailable");
        }
        return originalWritePage(pageInput, state);
      });

    await expect(runtime?.finalize("2026-08-20T12:00:00.000Z")).rejects.toThrow(
      ClaimsPersistenceError,
    );
    expect(await readPage(page)).toBe(originalContent);
    const store = new ClaimsStore(rootDir);
    expect((await store.loadPage(page))?.verification?.at).toBe(
      "2026-08-20T12:00:00.000Z",
    );

    writeSpy.mockRestore();
    const resumed = await prepareClaimsRuntime(
      "init",
      "repository",
      rootDir,
      new OpenWikiIgnore([]),
      () => undefined,
      { resumeInit: true },
    );
    await resumed?.finalize("2026-08-20T12:30:00.000Z");

    expect(parseFrontmatterFields(await readPage(page))?.verified).toEqual([
      {
        by: OPENWIKI_PRODUCER_ACTOR,
        at: "2026-08-20T12:00:00.000Z",
      },
    ]);
    expect((await store.loadPage(page))?.pageVersion).toBe(
      await store.hashPage(page),
    );
  });

  test("rejects orphan cleanup failure and removes the sidecar on retry", async () => {
    const orphanPage = "/openwiki/orphan.md";
    const store = new ClaimsStore(rootDir);
    await store.writePage(orphanPage, {
      schemaVersion: 1,
      pageVersion: `sha256:${"a".repeat(64)}`,
      claims: [],
    });
    const runtime = await prepareClaimsRuntime(
      "init",
      "repository",
      rootDir,
      new OpenWikiIgnore([]),
    );
    vi.spyOn(ClaimsStore.prototype, "deletePage").mockRejectedValueOnce(
      new ClaimsPersistenceError("cleanup unavailable"),
    );

    await expect(runtime?.finalize()).rejects.toThrow(ClaimsPersistenceError);
    await expect(store.loadPage(orphanPage)).resolves.not.toBeNull();

    await expect(runtime?.finalize()).resolves.toBeUndefined();
    await expect(store.loadPage(orphanPage)).resolves.toBeNull();
  });

  test("rejects deleted-page cleanup failure and removes the sidecar on retry", async () => {
    const page = "/openwiki/deleted.md";
    await writePage(page, "# Deleted\n");
    const store = new ClaimsStore(rootDir);
    await store.writePage(page, {
      schemaVersion: 1,
      pageVersion: await store.hashPage(page),
      claims: [],
    });
    const runtime = await prepareClaimsRuntime(
      "update",
      "repository",
      rootDir,
      new OpenWikiIgnore([]),
    );
    await runtime?.session.recordDeletion(page);
    await rm(path.join(rootDir, "openwiki", "deleted.md"));
    vi.spyOn(ClaimsStore.prototype, "deletePage").mockRejectedValueOnce(
      new ClaimsPersistenceError("deletion cleanup unavailable"),
    );

    await expect(runtime?.finalize()).rejects.toThrow(ClaimsPersistenceError);
    await expect(store.loadPage(page)).resolves.not.toBeNull();

    await expect(runtime?.finalize()).resolves.toBeUndefined();
    await expect(store.loadPage(page)).resolves.toBeNull();
  });
});
