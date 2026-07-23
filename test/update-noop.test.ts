import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  createRunContext,
  getUpdateNoopStatus,
  shouldCheckUpdateNoop,
} from "../src/agent/utils.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

/** Removes dangling objects by expiring the reflog and running gc --prune=now. */
async function gcPrune(repo: string): Promise<void> {
  await execFileAsync("git", ["reflog", "expire", "--expire=now", "--all"], {
    cwd: repo,
  });
  await execFileAsync("git", ["gc", "--prune=now", "-q"], { cwd: repo });
}

async function createRepoWithOpenWiki(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "openwiki-noop-"));
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "OpenWiki Test"]);
  await writeFile(path.join(repo, "README.md"), "# Test Repo\n", "utf8");
  await mkdir(path.join(repo, "openwiki"));
  await writeFile(
    path.join(repo, "openwiki", "quickstart.md"),
    "# Quickstart\n",
    "utf8",
  );
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

async function writeLastUpdate(
  repo: string,
  gitHead: string,
  updatedAt?: string,
): Promise<void> {
  await writeFile(
    path.join(repo, "openwiki", ".last-update.json"),
    `${JSON.stringify({
      updatedAt: updatedAt ?? new Date().toISOString(),
      command: "update",
      gitHead,
      model: "test-model",
    })}\n`,
    "utf8",
  );
}

describe("getUpdateNoopStatus", () => {
  test("detects a clean update with unchanged HEAD as a no-op", async () => {
    const repo = await createRepoWithOpenWiki();
    const head = await git(repo, ["rev-parse", "HEAD"]);
    await writeLastUpdate(repo, head);

    const status = await getUpdateNoopStatus(repo);

    expect(status.shouldSkip).toBe(true);
  });

  test("does not skip update when the worktree has uncommitted changes", async () => {
    const repo = await createRepoWithOpenWiki();
    const head = await git(repo, ["rev-parse", "HEAD"]);
    await writeLastUpdate(repo, head);
    await writeFile(
      path.join(repo, "README.md"),
      "# Test Repo\nChanged\n",
      "utf8",
    );

    const status = await getUpdateNoopStatus(repo);

    expect(status.shouldSkip).toBe(false);
  });

  test("skips update when commits since the last run only touch OpenWiki files", async () => {
    const repo = await createRepoWithOpenWiki();
    const head = await git(repo, ["rev-parse", "HEAD"]);
    await writeLastUpdate(repo, head);
    await writeFile(
      path.join(repo, "openwiki", "quickstart.md"),
      "# Quickstart\nUpdated\n",
      "utf8",
    );
    await git(repo, ["add", "openwiki/quickstart.md"]);
    await git(repo, ["commit", "-m", "update openwiki docs"]);

    const status = await getUpdateNoopStatus(repo);

    expect(status.shouldSkip).toBe(true);
  });

  test("does not skip update when commits since the last run touch source files", async () => {
    const repo = await createRepoWithOpenWiki();
    const head = await git(repo, ["rev-parse", "HEAD"]);
    await writeLastUpdate(repo, head);
    await writeFile(
      path.join(repo, "README.md"),
      "# Test Repo\nChanged\n",
      "utf8",
    );
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "update readme"]);

    const status = await getUpdateNoopStatus(repo);

    expect(status.shouldSkip).toBe(false);
  });
});

describe("shouldCheckUpdateNoop", () => {
  test("does not check for update no-op when an update message is provided", () => {
    expect(shouldCheckUpdateNoop({ userMessage: "document the API" })).toBe(
      false,
    );
  });

  test("checks for update no-op when no update message is provided", () => {
    expect(shouldCheckUpdateNoop({ userMessage: null })).toBe(true);
    expect(shouldCheckUpdateNoop({ userMessage: "   " })).toBe(true);
  });
});

describe("getUpdateNoopStatus — missing base commit (rewrite/amend scenario)", () => {
  test("does not skip update when the recorded gitHead no longer exists", async () => {
    const repo = await createRepoWithOpenWiki();
    const absentSha = "0000000000000000000000000000000000000000";
    await writeLastUpdate(repo, absentSha);

    const status = await getUpdateNoopStatus(repo);

    expect(status.shouldSkip).toBe(false);
    expect(status.reason).toMatch(/not found/);
    expect(status.reason).toContain(absentSha);
  });

  test("does not skip update when the recorded gitHead was amended and gc'd away", async () => {
    const repo = await createRepoWithOpenWiki();
    const originalHead = await git(repo, ["rev-parse", "HEAD"]);

    // Amend the commit so the original SHA becomes dangling.
    await writeFile(
      path.join(repo, "README.md"),
      "# Test Repo\nAmended\n",
      "utf8",
    );
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "--amend", "--no-edit"]);

    // Remove the dangling object so commitExists definitely returns false.
    await gcPrune(repo);

    await writeLastUpdate(repo, originalHead);

    const status = await getUpdateNoopStatus(repo);

    expect(status.shouldSkip).toBe(false);
    expect(status.reason).toMatch(/not found/);
    expect(status.reason).toContain(originalHead);
  });

  test("does not skip when missing gitHead in metadata", async () => {
    const repo = await createRepoWithOpenWiki();
    // Write metadata with gitHead omitted (e.g., older format or local-wiki metadata).
    await writeFile(
      path.join(repo, "openwiki", ".last-update.json"),
      `${JSON.stringify({
        updatedAt: new Date().toISOString(),
        command: "update",
        model: "test-model",
      })}\n`,
      "utf8",
    );

    const status = await getUpdateNoopStatus(repo);

    expect(status.shouldSkip).toBe(false);
    expect(status.reason).toContain("missing previous update git head");
  });
});

describe("createRunContext git summary — present base commit (happy path)", () => {
  test("uses precise gitHead..HEAD range when recorded commit exists", async () => {
    const repo = await createRepoWithOpenWiki();
    const baseHead = await git(repo, ["rev-parse", "HEAD"]);
    await writeLastUpdate(repo, baseHead);

    // Add a source commit after the recorded head.
    await writeFile(
      path.join(repo, "README.md"),
      "# Test Repo\nChanged\n",
      "utf8",
    );
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "change readme"]);

    const context = await createRunContext("update", repo, "repository");

    // Should use the exact gitHead..HEAD diff, not the time-based fallback.
    expect(context.gitSummary).toContain(
      `git log ${baseHead}..HEAD --name-status --oneline`,
    );
    // The "no longer present" note must NOT appear.
    expect(context.gitSummary).not.toMatch(/no longer present/i);
  });
});

describe("createRunContext git summary — missing base commit (rewrite/amend scenario)", () => {
  test("does not include a fatal git error in gitSummary when recorded gitHead is absent", async () => {
    const repo = await createRepoWithOpenWiki();
    const absentSha = "0000000000000000000000000000000000000000";
    await writeLastUpdate(repo, absentSha);

    const context = await createRunContext("update", repo, "repository");

    expect(context.gitSummary).not.toMatch(/^fatal:/m);
    expect(context.gitSummary).not.toContain("Invalid revision range");
  });

  test("includes a note and time-based fallback evidence when recorded gitHead is absent", async () => {
    const repo = await createRepoWithOpenWiki();
    const absentSha = "0000000000000000000000000000000000000000";
    await writeLastUpdate(repo, absentSha);

    const context = await createRunContext("update", repo, "repository");

    expect(context.gitSummary).toContain(absentSha);
    expect(context.gitSummary).toMatch(/no longer present/i);
    // Falls back to git log --since which should appear in the evidence.
    expect(context.gitSummary).toContain("git log --since");
  });

  test("uses time-based fallback after a gc'd amend, no fatal error", async () => {
    const repo = await createRepoWithOpenWiki();
    const originalHead = await git(repo, ["rev-parse", "HEAD"]);

    // Amend and gc so the original commit is truly gone.
    await writeFile(
      path.join(repo, "README.md"),
      "# Test Repo\nAmended\n",
      "utf8",
    );
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "--amend", "--no-edit"]);
    await gcPrune(repo);

    await writeLastUpdate(repo, originalHead);

    const context = await createRunContext("update", repo, "repository");

    expect(context.gitSummary).not.toMatch(/^fatal:/m);
    expect(context.gitSummary).not.toContain("Invalid revision range");
    expect(context.gitSummary).toMatch(/no longer present/i);
    expect(context.gitSummary).toContain(originalHead);
    expect(context.gitSummary).toContain("git log --since");
  });
});
