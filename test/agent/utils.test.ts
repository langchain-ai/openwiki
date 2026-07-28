import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  createOpenWikiContentSnapshot,
  createRunContext,
  getUpdateNoopStatus,
  removeTemporaryPlanFile,
} from "../../src/agent/utils.ts";

// These cover the branches of utils.ts that the sibling run-context,
// run-metadata, and update-noop suites do not reach: the repository-mode git
// evidence block, the local-wiki summary text, the degenerate no-op paths, the
// snapshot recursion, and the unexpected-error path of plan-file removal.

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

describe("createRunContext git summary", () => {
  test("init in a repository embeds the standard git evidence sections", async () => {
    const repo = await createGitRepo();

    try {
      const context = await createRunContext("init", repo, "repository");

      // The prompt relies on these labeled sections to reason about the repo,
      // so their presence is the observable contract of createGitSummary.
      expect(context.gitSummary).toContain("$ git status --short");
      expect(context.gitSummary).toContain("$ git rev-parse HEAD");
      expect(context.gitSummary).toContain(
        "$ git log --max-count=20 --name-status --oneline",
      );
      expect(context.gitSummary).toContain("$ git diff --name-status HEAD");
      // An init run has no prior timestamp, but the "No prior" note is reserved
      // for update runs and must not appear here.
      expect(context.gitSummary).not.toContain(
        "No prior OpenWiki update timestamp",
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("update without prior metadata falls back to the recent log with a note", async () => {
    const repo = await createGitRepo();

    try {
      const context = await createRunContext("update", repo, "repository");

      expect(context.gitSummary).toContain(
        "No prior OpenWiki update timestamp was found.",
      );
      expect(context.gitSummary).toContain(
        "$ git log --max-count=20 --name-status --oneline",
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("update diffs since the recorded git head when one exists", async () => {
    const repo = await createGitRepo();

    try {
      const firstHead = await git(repo, ["rev-parse", "HEAD"]);
      await writeFile(path.join(repo, "README.md"), "# Changed\n", "utf8");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "second"]);
      await writeMetadata(repo, {
        updatedAt: new Date().toISOString(),
        command: "update",
        gitHead: firstHead,
        model: "test-model",
      });

      const context = await createRunContext("update", repo, "repository");

      // A recorded head drives a precise range diff rather than the timestamp
      // fallback or the recent-log fallback.
      expect(context.gitSummary).toContain(
        `$ git log ${firstHead}..HEAD --name-status --oneline`,
      );
      expect(context.gitSummary).not.toContain(
        "No prior OpenWiki update timestamp",
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("update falls back to a --since log when only a timestamp was recorded", async () => {
    const repo = await createGitRepo();

    try {
      // Metadata that predates the gitHead field still carries updatedAt, which
      // selects the `git log --since` branch.
      await writeMetadata(repo, {
        updatedAt: "2020-01-01T00:00:00.000Z",
        command: "update",
        model: "test-model",
      });

      const context = await createRunContext("update", repo, "repository");

      expect(context.gitSummary).toContain(
        "$ git log --since 2020-01-01T00:00:00.000Z --name-status --oneline",
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("local-wiki mode reports that git context is not used", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-utils-local-"));

    try {
      const context = await createRunContext("update", cwd, "local-wiki");

      expect(context.gitSummary).toContain("Local wiki mode");
      expect(context.gitSummary).not.toContain("$ git status");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

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
});

describe("removeTemporaryPlanFile error handling", () => {
  test("propagates unexpected errors instead of swallowing them", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-utils-plan-"));

    try {
      // A directory where the plan file is expected makes rm fail with a
      // non-ENOENT error. That is not the tolerated "already gone" case, so it
      // must surface rather than be reported as a benign "nothing removed".
      await mkdir(path.join(cwd, "openwiki", "_plan.md"), { recursive: true });

      await expect(
        removeTemporaryPlanFile(cwd, "repository"),
      ).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
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
});
