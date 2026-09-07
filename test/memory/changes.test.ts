import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ClaimsStore } from "../../src/claims/brains/code/store.ts";
import { formatRepositoryEvidenceResource } from "../../src/claims/evidence/repository/resource.ts";
import {
  readRepositoryPageManifest,
  writeRepositoryPageManifest,
} from "../../src/generation/page-manifest.ts";
import {
  orientChanges,
  outlineChanges,
  readChanges,
} from "../../src/memory/changes.ts";
import type { MemoryLayer } from "../../src/memory/types.ts";
import { HostSessionManager } from "../../src/integrations/core/session-manager.ts";

/**
 * Temporary repositories owned by the current test, including local shallow clones.
 */
const roots: string[] = [];

/**
 * Current fixture repository root.
 */
let root: string;

/**
 * Original source commit recorded by the fixture wiki.
 */
let checkpoint: string;

/**
 * Factual page with independent retry and cancellation evidence.
 */
const PAGE = "concepts/jobs.md";

/**
 * Complete directory, including the legacy quickstart used by orient.
 */
const PAGES = [PAGE, "quickstart.md"];

/**
 * Executes Git in the isolated fixture without user signing or commit identity requirements.
 *
 * @param args - Literal Git argument vector.
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
 * Writes a repository-relative fixture file, creating its parent directory.
 *
 * @param file - Repository-relative path.
 * @param content - Exact text or binary bytes.
 */
async function write(file: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
}

/**
 * Commits all fixture changes and returns the resulting commit identity.
 *
 * @param message - Test-readable commit purpose.
 * @returns New HEAD commit.
 */
function commit(message: string): string {
  git("add", ".");
  git("commit", "--quiet", "-m", message);
  return git("rev-parse", "HEAD");
}

/**
 * Narrows a successfully computed layer for concise behavior assertions.
 *
 * @param layer - Result of one comparison.
 * @returns Changes, failing the test with the unavailable reason when necessary.
 */
function changes<T>(layer: MemoryLayer<T>): T[] {
  if ("unavailable" in layer) throw new Error(layer.unavailable);
  return layer.changes;
}

/**
 * Writes a linked page at a specified source checkpoint without running a model.
 *
 * @param page - Wiki-relative output path.
 * @param source - Source commit covered by this page.
 * @param retryPath - Repository source path supporting the retry claim.
 */
async function writePage(
  page = PAGE,
  source = checkpoint,
  retryPath = "src/retry.ts",
): Promise<void> {
  await write(
    `openwiki/${page}`,
    "---\ntype: concept\ntitle: Jobs\ndescription: Retry and cancellation behavior.\n---\n# Jobs\n\n## Retries\n\nJobs receive three attempts.\n\n## Cancellation\n\nCancellation stops new attempts.\n",
  );
  const store = new ClaimsStore(root);
  const pageVersion = await store.hashPage(`/openwiki/${page}`);
  await store.writePage(`/openwiki/${page}`, {
    schemaVersion: 1,
    pageVersion,
    claims: [
      {
        id: "claim_retry",
        statement: "Jobs receive three attempts.",
        evidence: [
          {
            resource: `${formatRepositoryEvidenceResource({ path: retryPath })}#L1-L1`,
            version: "retry-v1",
          },
        ],
      },
      {
        id: "claim_cancel",
        statement: "Cancellation stops new attempts.",
        evidence: [{ resource: "repo://src/cancel.ts", version: "cancel-v1" }],
      },
    ],
    sections: [
      {
        id: "section_jobs",
        location: `${page}#Jobs`,
        description: "Job lifecycle.",
      },
      {
        id: "section_retry",
        location: `${page}#Jobs#Retries`,
        description: "Attempt limits.",
      },
      {
        id: "section_cancel",
        location: `${page}#Jobs#Cancellation`,
        description: "Cancellation behavior.",
      },
    ],
    bindings: [
      {
        id: "binding_retry",
        sectionId: "section_retry",
        text: "Jobs receive three attempts.",
        claimIds: ["claim_retry"],
      },
      {
        id: "binding_cancel",
        sectionId: "section_cancel",
        text: "Cancellation stops new attempts.",
        claimIds: ["claim_cancel"],
      },
    ],
  });
  const manifest = await readRepositoryPageManifest(root);
  manifest.pages[`/openwiki/${page}`] = { gitHead: source, pageVersion };
  await writeRepositoryPageManifest(root, manifest);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openwiki-change-tests-"));
  roots.push(root);
  git("init", "--quiet", "-b", "main");
  await write("src/retry.ts", "export const attempts = 3;\n");
  await write("src/cancel.ts", "export const cancel = true;\n");
  await write(".gitignore", "ignored/\n");
  checkpoint = commit("source baseline");
  await writePage();
  await write(
    "openwiki/quickstart.md",
    "---\ntitle: Quickstart\ndescription: Repository orientation.\n---\n# Quickstart\n\nAcme runs background jobs.\n",
  );
  await write(
    "openwiki/.last-update.json",
    JSON.stringify({
      updatedAt: "2026-09-06T12:00:00Z",
      command: "init",
      model: "test",
      gitHead: checkpoint,
      status: "complete",
    }),
  );
  commit("wiki baseline");
});

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("source change memory", () => {
  test("returns the three agreed layers through all tool definitions without starting a run", async () => {
    await write("src/retry.ts", "export const attempts = 5;\n");
    commit("main change");
    await write("src/retry.ts", "export const attempts = 7;\n");
    const tools = HostSessionManager.create({ host: "codex" }).tools();
    const orient = await tools
      .find(({ name }) => name === "openwiki_orient")!
      .handle({ root });
    expect(orient).toMatchObject({
      longTerm: { overview: "Acme runs background jobs." },
      shortTerm: {
        changes: [
          {
            resource: "repo://src/retry.ts",
            inCheckout: true,
            affectedPages: [PAGE],
          },
        ],
      },
      working: {
        changes: [{ resource: "repo://src/retry.ts", affectedPages: [PAGE] }],
      },
    });
    const outline = await tools
      .find(({ name }) => name === "openwiki_outline")!
      .handle({ root, page: PAGE });
    expect(outline).toMatchObject({
      longTerm: { page: PAGE },
      shortTerm: {
        changes: [
          {
            resource: "repo://src/retry.ts",
            inCheckout: true,
            affectedSectionIds: ["section_retry"],
          },
        ],
      },
      working: {
        changes: [
          {
            resource: "repo://src/retry.ts",
            affectedSectionIds: ["section_retry"],
          },
        ],
      },
    });
    const read = await tools
      .find(({ name }) => name === "openwiki_read")!
      .handle({ root, page: PAGE, sections: ["section_jobs"] });
    const source = await readChanges(root, PAGE, [
      "section_jobs",
      "section_retry",
      "section_cancel",
    ]);
    expect(read).toEqual({
      longTerm: {
        page: PAGE,
        sections: [
          {
            id: "section_jobs",
            location: `${PAGE}#Jobs`,
            content: "# Jobs\n\n",
          },
          {
            id: "section_retry",
            location: `${PAGE}#Jobs#Retries`,
            content: "## Retries\n\nJobs receive three attempts.\n\n",
          },
          {
            id: "section_cancel",
            location: `${PAGE}#Jobs#Cancellation`,
            content: "## Cancellation\n\nCancellation stops new attempts.\n",
          },
        ],
        bindings: [
          {
            id: "binding_retry",
            sectionId: "section_retry",
            text: "Jobs receive three attempts.",
            claimIds: ["claim_retry"],
          },
          {
            id: "binding_cancel",
            sectionId: "section_cancel",
            text: "Cancellation stops new attempts.",
            claimIds: ["claim_cancel"],
          },
        ],
        claims: [
          {
            id: "claim_retry",
            statement: "Jobs receive three attempts.",
            evidence: [{ resource: "repo://src/retry.ts#L1-L1" }],
          },
          {
            id: "claim_cancel",
            statement: "Cancellation stops new attempts.",
            evidence: [{ resource: "repo://src/cancel.ts" }],
          },
        ],
      },
      shortTerm: { ...source.shortTerm, reflections: [] },
      working: { ...source.working, reflections: [] },
    });
  });

  test("reports large untracked sources without returning their contents", async () => {
    await writePage(PAGE, checkpoint, "src/new.ts");
    await write("src/new.ts", Buffer.alloc(9 * 1024 * 1024, "a"));
    const result = await readChanges(root, PAGE, ["section_retry"]);
    expect(changes(result.working)).toEqual([
      { resource: "repo://src/new.ts", affectedClaimIds: ["claim_retry"] },
    ]);
  });

  test("returns checked empty layers for an unchanged repository", async () => {
    const empty = { shortTerm: { changes: [] }, working: { changes: [] } };
    expect(await orientChanges(root, PAGES)).toEqual(empty);
    expect(await outlineChanges(root, PAGE)).toEqual(empty);
    expect(await readChanges(root, PAGE, ["section_retry"])).toEqual(empty);
  });

  test("follows three to five on main and five to seven locally through every output shape", async () => {
    await write("src/retry.ts", "export const attempts = 5;\n");
    commit("increase main retry limit");
    await write("src/retry.ts", "export const attempts = 7;\n");
    const resource = "repo://src/retry.ts";
    expect(await orientChanges(root, PAGES)).toEqual({
      shortTerm: {
        changes: [{ resource, affectedPages: [PAGE], inCheckout: true }],
      },
      working: { changes: [{ resource, affectedPages: [PAGE] }] },
    });
    expect(await outlineChanges(root, PAGE)).toEqual({
      shortTerm: {
        changes: [
          { resource, affectedSectionIds: ["section_retry"], inCheckout: true },
        ],
      },
      working: {
        changes: [{ resource, affectedSectionIds: ["section_retry"] }],
      },
    });
    const result = await readChanges(root, PAGE, ["section_retry"]);
    const main = changes(result.shortTerm)[0];
    const working = changes(result.working)[0];
    expect(main).toEqual({
      resource,
      affectedClaimIds: ["claim_retry"],
      inCheckout: true,
    });
    expect(working).toEqual({ resource, affectedClaimIds: ["claim_retry"] });
    expect(await readChanges(root, PAGE, ["section_cancel"])).toEqual({
      shortTerm: { changes: [] },
      working: { changes: [] },
    });
  });

  test("keeps missing upstream additions out of working memory on a branch behind main", async () => {
    git("branch", "feature");
    await write("src/retry.ts", "export const attempts = 5;\n");
    await write("src/incoming.ts", "export const incoming = true;\n");
    commit("upstream changes");
    git("switch", "--quiet", "feature");
    await write("src/retry.ts", "export const attempts = 7;\n");
    const result = await orientChanges(root, PAGES);
    expect(changes(result.shortTerm)).toEqual([
      {
        resource: "repo://src/incoming.ts",
        affectedPages: [],
        inCheckout: false,
      },
      {
        resource: "repo://src/retry.ts",
        affectedPages: [PAGE],
        inCheckout: false,
      },
    ]);
    expect(changes(result.working)).toEqual([
      { resource: "repo://src/retry.ts", affectedPages: [PAGE] },
    ]);
    const read = await readChanges(root, PAGE, ["section_retry"]);
    expect(changes(read.working)).toEqual([
      { resource: "repo://src/retry.ts", affectedClaimIds: ["claim_retry"] },
    ]);
  });

  test("tracks incorporation by resource history even when main continues ahead", async () => {
    await write("src/retry.ts", "export const attempts = 5;\n");
    commit("incorporated retry change");
    git("branch", "feature");
    await write("src/cancel.ts", "export const cancel = false;\n");
    commit("incoming cancellation change");
    git("switch", "--quiet", "feature");
    await write("src/retry.ts", "export const attempts = 7;\n");
    commit("local retry change");
    const result = await orientChanges(root, PAGES);
    expect(changes(result.shortTerm)).toEqual([
      {
        resource: "repo://src/cancel.ts",
        affectedPages: [PAGE],
        inCheckout: false,
      },
      {
        resource: "repo://src/retry.ts",
        affectedPages: [PAGE],
        inCheckout: true,
      },
    ]);
    expect(changes(result.working)).toEqual([
      { resource: "repo://src/retry.ts", affectedPages: [PAGE] },
    ]);
  });

  test("includes branch commits, staged edits, unstaged edits, and untracked sources as net work", async () => {
    git("switch", "--quiet", "-c", "feature");
    await write("src/retry.ts", "export const attempts = 5;\n");
    commit("branch change");
    await write("src/retry.ts", "export const attempts = 7;\n");
    git("add", "src/retry.ts");
    await write("src/retry.ts", "export const attempts = 9;\n");
    await write("src/new.ts", "export const fresh = true;\n");
    await write("ignored/private.txt", "ignored content");
    await write("openwiki/log.md", "generated output");
    const status = git("status", "--porcelain=v1");
    const index = await readFile(path.join(root, ".git/index"));
    const result = await orientChanges(root, PAGES);
    expect(changes(result.working)).toEqual([
      { resource: "repo://src/new.ts", affectedPages: [] },
      { resource: "repo://src/retry.ts", affectedPages: [PAGE] },
    ]);
    const read = await readChanges(root, PAGE, ["section_retry"]);
    expect(changes(read.working)).toEqual([
      { resource: "repo://src/retry.ts", affectedClaimIds: ["claim_retry"] },
    ]);
    expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
    expect(git("status", "--porcelain=v1")).toBe(status);
    await write("src/retry.ts", "export const attempts = 3;\n");
    expect(
      changes((await readChanges(root, PAGE, ["section_retry"])).working),
    ).toEqual([]);
  });

  test("treats a partly incorporated aggregate main change as incoming", async () => {
    await write("src/retry.ts", "export const attempts = 5;\n");
    commit("first main change");
    git("branch", "feature");
    await write("src/retry.ts", "export const attempts = 7;\n");
    commit("second main change");
    git("switch", "--quiet", "feature");
    let result = await readChanges(root, PAGE, ["section_retry"]);
    expect(changes(result.shortTerm)[0].inCheckout).toBe(false);
    expect(changes(result.working)).toEqual([]);
    git("merge", "--quiet", "--ff-only", "main");
    await write("src/retry.ts", "export const attempts = 9;\n");
    result = await readChanges(root, PAGE, ["section_retry"]);
    expect(changes(result.shortTerm)[0].inCheckout).toBe(true);
    expect(changes(result.working)).toEqual([
      { resource: "repo://src/retry.ts", affectedClaimIds: ["claim_retry"] },
    ]);
  });

  test("uses page-specific coverage after a partial update", async () => {
    const oldPage = "concepts/older-jobs.md";
    await writePage(oldPage);
    commit("older page");
    await write("src/retry.ts", "export const attempts = 5;\n");
    const newer = commit("main change");
    await writePage(PAGE, newer);
    const result = await orientChanges(root, [...PAGES, oldPage]);
    expect(changes(result.shortTerm)).toEqual([
      {
        resource: "repo://src/retry.ts",
        affectedPages: [oldPage],
        inCheckout: true,
      },
    ]);
    expect(
      changes((await readChanges(root, PAGE, ["section_retry"])).shortTerm),
    ).toEqual([]);
    expect(
      changes((await readChanges(root, oldPage, ["section_retry"])).shortTerm),
    ).toEqual([
      {
        resource: "repo://src/retry.ts",
        affectedClaimIds: ["claim_retry"],
        inCheckout: true,
      },
    ]);
  });

  test("uses shared main history when the wiki was updated on a feature branch", async () => {
    git("switch", "--quiet", "-c", "feature");
    await write("src/branch-only.ts", "branch content\n");
    const branchHead = commit("feature source");
    await writePage(PAGE, branchHead);
    const result = await outlineChanges(root, PAGE);
    expect(changes(result.shortTerm)).toEqual([]);
    expect(changes(result.working)).toEqual([]);
  });

  test("represents renames as deletion and addition while keeping old evidence connected", async () => {
    git("mv", "src/retry.ts", "src/attempts.ts");
    const result = await orientChanges(root, PAGES);
    expect(changes(result.working)).toEqual([
      { resource: "repo://src/attempts.ts", affectedPages: [] },
      { resource: "repo://src/retry.ts", affectedPages: [PAGE] },
    ]);
    const read = await readChanges(root, PAGE, ["section_retry"]);
    expect(changes(read.working)).toEqual([
      { resource: "repo://src/retry.ts", affectedClaimIds: ["claim_retry"] },
    ]);
  });

  test("exposes binary and untracked-file changes without hiding their resources", async () => {
    await write("src/cancel.ts", Buffer.from([0, 1, 2, 3]));
    const result = await readChanges(root, PAGE, ["section_cancel"]);
    expect(changes(result.working)).toEqual([
      { resource: "repo://src/cancel.ts", affectedClaimIds: ["claim_cancel"] },
    ]);
    git("rm", "--cached", "--quiet", "src/retry.ts");
    expect(
      changes((await readChanges(root, PAGE, ["section_retry"])).working),
    ).toEqual([]);
    await write("src/retry.ts", "export const attempts = 7;\n");
    const recreated = changes(
      (await readChanges(root, PAGE, ["section_retry"])).working,
    )[0];
    expect(recreated).toEqual({
      resource: "repo://src/retry.ts",
      affectedClaimIds: ["claim_retry"],
    });
  });

  test("handles literal pathspec characters and encoded repository resources", async () => {
    const file = "src/[retry] 100%.ts";
    await write(file, "three\n");
    const baseline = commit("literal filename");
    await writePage(PAGE, baseline, file);
    await write(file, "five\n");
    const result = await readChanges(root, PAGE, ["section_retry"]);
    expect(changes(result.working)[0]).toEqual({
      resource: formatRepositoryEvidenceResource({ path: file }),
      affectedClaimIds: ["claim_retry"],
    });
  });

  test("honors OpenWiki ignore rules when identifying changed resources", async () => {
    await write(".openwikiignore", "src/retry.ts\n");
    commit("exclude retry evidence");
    await write("src/retry.ts", "secret source detail\n");
    const result = await readChanges(root, PAGE, ["section_retry"]);
    expect(changes(result.working)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("secret source detail");
  });

  test("reports a missing wiki checkpoint while keeping working memory available", async () => {
    await writePage(PAGE, "f".repeat(40));
    await write("src/retry.ts", "export const attempts = 7;\n");
    const result = await readChanges(root, PAGE, ["section_retry"]);
    expect(result.shortTerm).toEqual({
      unavailable:
        "The wiki checkpoint is missing from local Git history. Fetch the required history and retry.",
    });
    expect(changes(result.working)).toEqual([
      { resource: "repo://src/retry.ts", affectedClaimIds: ["claim_retry"] },
    ]);
  });

  test("uses legacy whole-wiki coverage only when no explicit page checkpoint exists", async () => {
    await rm(path.join(root, "openwiki/.page-manifest.json"));
    expect(changes((await outlineChanges(root, PAGE)).shortTerm)).toEqual([]);
    await writePage();
    const manifest = await readRepositoryPageManifest(root);
    delete manifest.pages[`/openwiki/${PAGE}`].gitHead;
    await writeRepositoryPageManifest(root, manifest);
    const result = await outlineChanges(root, PAGE);
    expect(result.shortTerm).toHaveProperty("unavailable");
    expect(result.working).toEqual({ changes: [] });
  });

  test("reports missing default-branch history instead of assuming the current branch is main", async () => {
    git("branch", "-m", "feature");
    const result = await orientChanges(root, PAGES);
    expect(result.shortTerm).toHaveProperty("unavailable");
    expect(result.working).toHaveProperty("unavailable");
    expect(JSON.stringify(result)).toContain("No locally known main branch");
  });

  test("uses the newer comparable local or origin tip and supports detached checkouts", async () => {
    const older = git("rev-parse", "HEAD");
    await write("src/retry.ts", "export const attempts = 5;\n");
    const newer = commit("upstream retry change");
    git("update-ref", "refs/remotes/origin/main", older);
    expect(
      changes((await orientChanges(root, PAGES)).shortTerm)[0].inCheckout,
    ).toBe(true);
    git("update-ref", "refs/remotes/origin/main", newer);
    git("switch", "--quiet", "--detach", older);
    git("update-ref", "refs/heads/main", older);
    const result = await orientChanges(root, PAGES);
    expect(changes(result.shortTerm)[0].inCheckout).toBe(false);
    expect(changes(result.working)).toEqual([]);
  });

  test("supports origin's named default and rejects diverged local and origin main histories", async () => {
    git("branch", "-m", "trunk");
    git("update-ref", "refs/remotes/origin/trunk", git("rev-parse", "HEAD"));
    git(
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/trunk",
    );
    expect(changes((await orientChanges(root, PAGES)).shortTerm)).toEqual([]);
    git("switch", "--quiet", "-c", "other");
    await write("src/remote.ts", "remote\n");
    git("update-ref", "refs/remotes/origin/trunk", commit("remote divergence"));
    git("switch", "--quiet", "trunk");
    await write("src/local.ts", "local\n");
    commit("local divergence");
    expect(JSON.stringify(await orientChanges(root, PAGES))).toContain(
      "have diverged",
    );
  });

  test("reports shallow history gaps without discarding a valid working comparison", async () => {
    const clone = await mkdtemp(
      path.join(os.tmpdir(), "openwiki-shallow-memory-"),
    );
    roots.push(clone);
    git("clone", "--quiet", "--depth=1", `file://${root}`, clone);
    const result = await outlineChanges(clone, PAGE);
    expect(result.shortTerm).toHaveProperty("unavailable");
    expect(result.working).toEqual({ changes: [] });
  });

  test("leaves short-term memory available when working files contain merge conflicts", async () => {
    git("switch", "--quiet", "-c", "feature");
    await write("src/retry.ts", "export const attempts = 7;\n");
    commit("feature version");
    git("switch", "--quiet", "main");
    await write("src/retry.ts", "export const attempts = 5;\n");
    commit("main version");
    git("switch", "--quiet", "feature");
    expect(() => git("merge", "--no-edit", "main")).toThrow();
    const result = await readChanges(root, PAGE, ["section_retry"]);
    expect(changes(result.shortTerm)).toEqual([
      {
        resource: "repo://src/retry.ts",
        affectedClaimIds: ["claim_retry"],
        inCheckout: false,
      },
    ]);
    expect(result.working).toHaveProperty("unavailable");
  });

  test("does not invoke configured external diff commands or traverse source directory aliases", async () => {
    git("config", "diff.external", "command-that-must-not-run");
    await write("src/retry.ts", "export const attempts = 7;\n");
    expect(
      changes((await readChanges(root, PAGE, ["section_retry"])).working),
    ).toEqual([
      { resource: "repo://src/retry.ts", affectedClaimIds: ["claim_retry"] },
    ]);
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "openwiki-outside-memory-"),
    );
    roots.push(outside);
    await writeFile(
      path.join(outside, "retry.ts"),
      "private external contents",
    );
    await rm(path.join(root, "src"), { recursive: true, force: true });
    await symlink(outside, path.join(root, "src"));
    const result = await readChanges(root, PAGE, ["section_retry"]);
    expect(result.working).toHaveProperty("unavailable");
    expect(JSON.stringify(result)).not.toContain("private external contents");
  });
});
