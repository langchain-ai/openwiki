import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  createOpenWikiContentSnapshot,
  createRepositorySourceFingerprint,
  getUpdateNoopStatus,
} from "../../src/agent/utils.ts";
import { OpenWikiIgnore } from "../../src/agent/openwiki-ignore.ts";
import { RepositoryWikiPaths } from "../../src/repository-wiki/paths.ts";

// These cover the branches of utils.ts that the sibling run-context,
// run-metadata, and update-noop suites do not reach: the degenerate no-op
// paths and snapshot recursion. (createRunContext's own behavior is covered by run-context.test.ts;
// it no longer computes a git summary in code — the agent runs git itself.)

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

/**
 * Creates a temp git repo with one commit so createGitSummary has real
 * `git status`/`git log`/`git diff` output to format.
 */
async function createGitRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "openwiki-utils-"));
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "OpenWiki Test"]);
  await writeFile(path.join(repo, "README.md"), "# Test Repo\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

async function writeMetadata(
  repo: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await mkdir(path.join(repo, "openwiki"), { recursive: true });
  await writeFile(
    path.join(repo, "openwiki", ".last-update.json"),
    `${JSON.stringify(metadata)}\n`,
    "utf8",
  );
}

describe("getUpdateNoopStatus degenerate cases", () => {
  test("does not skip when prior metadata has no git head", async () => {
    const repo = await createGitRepo();

    try {
      // Metadata without a gitHead cannot be diffed against, so a skip would be
      // unsafe: the run must proceed.
      await writeMetadata(repo, {
        updatedAt: new Date().toISOString(),
        command: "update",
        model: "test-model",
      });

      expect(await getUpdateNoopStatus(repo)).toEqual({
        shouldSkip: false,
        reason: "missing previous update git head",
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("treats structurally invalid metadata as no prior update", async () => {
    const repo = await createGitRepo();

    try {
      // Valid JSON but missing the required fields readLastUpdate checks: it is
      // rejected as if there were no prior run at all.
      await writeMetadata(repo, { note: "not real metadata" });

      expect(await getUpdateNoopStatus(repo)).toEqual({
        shouldSkip: false,
        reason: "missing previous update git head",
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("reads metadata and filters generated changes below the configured root", async () => {
    const repo = await createGitRepo();
    const wikiPaths = new RepositoryWikiPaths("docs");

    try {
      await mkdir(path.join(repo, "docs"), { recursive: true });
      await writeFile(path.join(repo, "docs/page.md"), "# Generated\n");
      await git(repo, ["add", "docs/page.md"]);
      await git(repo, ["commit", "-m", "add generated wiki"]);
      const gitHead = await git(repo, ["rev-parse", "HEAD"]);
      await writeFile(
        path.join(repo, "docs/.last-update.json"),
        `${JSON.stringify({
          updatedAt: new Date().toISOString(),
          command: "update",
          model: "test-model",
          gitHead,
          status: "complete",
        })}\n`,
      );

      await expect(
        getUpdateNoopStatus(repo, new OpenWikiIgnore([]), undefined, wikiPaths),
      ).resolves.toMatchObject({ shouldSkip: true });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("createOpenWikiContentSnapshot recursion", () => {
  test("hashes nested files and changes when nested content changes", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-utils-snap-"));

    try {
      const nestedDir = path.join(cwd, "openwiki", "guides");
      await mkdir(nestedDir, { recursive: true });
      await writeFile(path.join(nestedDir, "intro.md"), "# Intro\n", "utf8");

      const before = await createOpenWikiContentSnapshot(cwd, "repository");
      // The snapshot must be stable for identical content so unchanged runs are
      // detected as no-ops.
      expect(await createOpenWikiContentSnapshot(cwd, "repository")).toBe(
        before,
      );

      await writeFile(path.join(nestedDir, "intro.md"), "# Changed\n", "utf8");
      const after = await createOpenWikiContentSnapshot(cwd, "repository");

      // A change buried in a subdirectory must still alter the hash, proving the
      // walk recurses rather than only hashing the top level.
      expect(after).not.toBe(before);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("includes claim sidecars while excluding run metadata", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-utils-claims-"));

    try {
      const claimsDir = path.join(cwd, "openwiki", ".claims");
      await mkdir(claimsDir, { recursive: true });
      await writeFile(path.join(cwd, "openwiki", "page.md"), "# Page\n");
      await writeFile(path.join(claimsDir, "page.json"), '{"revision":1}\n');
      const before = await createOpenWikiContentSnapshot(cwd, "repository");

      await writeFile(
        path.join(cwd, "openwiki", ".last-update.json"),
        '{"status":"complete"}\n',
      );
      expect(await createOpenWikiContentSnapshot(cwd, "repository")).toBe(
        before,
      );

      await writeFile(
        path.join(cwd, "openwiki", ".run.json"),
        '{"phase":"generating"}\n',
      );
      expect(await createOpenWikiContentSnapshot(cwd, "repository")).toBe(
        before,
      );

      await writeFile(path.join(claimsDir, "page.json"), '{"revision":2}\n');
      expect(await createOpenWikiContentSnapshot(cwd, "repository")).not.toBe(
        before,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("snapshots only the configured repository wiki tree", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-utils-custom-"));
    const wikiPaths = new RepositoryWikiPaths("docs");

    try {
      await mkdir(path.join(cwd, "docs"), { recursive: true });
      await mkdir(path.join(cwd, "openwiki"), { recursive: true });
      await writeFile(path.join(cwd, "docs/page.md"), "# Docs\n");
      await writeFile(path.join(cwd, "openwiki/source.md"), "# Source\n");
      const before = await createOpenWikiContentSnapshot(
        cwd,
        "repository",
        wikiPaths,
      );

      await writeFile(path.join(cwd, "openwiki/source.md"), "# Changed\n");
      await expect(
        createOpenWikiContentSnapshot(cwd, "repository", wikiPaths),
      ).resolves.toBe(before);

      await writeFile(path.join(cwd, "docs/page.md"), "# Changed\n");
      await expect(
        createOpenWikiContentSnapshot(cwd, "repository", wikiPaths),
      ).resolves.not.toBe(before);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("createRepositorySourceFingerprint configured root", () => {
  test("excludes the selected wiki while retaining an openwiki source directory", async () => {
    const repo = await createGitRepo();
    const wikiPaths = new RepositoryWikiPaths("docs");
    const ignore = new OpenWikiIgnore([]);

    try {
      await mkdir(path.join(repo, "docs"), { recursive: true });
      await mkdir(path.join(repo, "openwiki"), { recursive: true });
      await writeFile(path.join(repo, "docs/generated.md"), "# Generated\n");
      await writeFile(
        path.join(repo, "openwiki/source.ts"),
        "export const value = 1;\n",
      );
      const before = await createRepositorySourceFingerprint(
        repo,
        ignore,
        wikiPaths,
      );

      await writeFile(path.join(repo, "docs/generated.md"), "# Updated\n");
      await expect(
        createRepositorySourceFingerprint(repo, ignore, wikiPaths),
      ).resolves.toBe(before);

      await writeFile(
        path.join(repo, "openwiki/source.ts"),
        "export const value = 2;\n",
      );
      await expect(
        createRepositorySourceFingerprint(repo, ignore, wikiPaths),
      ).resolves.not.toBe(before);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
