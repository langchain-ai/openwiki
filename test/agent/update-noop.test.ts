import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { OpenWikiIgnore } from "../../src/agent/openwiki-ignore.ts";
import {
  getUpdateNoopStatus,
  shouldCheckUpdateNoop,
} from "../../src/agent/utils.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
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
  extraFields: Record<string, unknown> = {},
): Promise<void> {
  await writeFile(
    path.join(repo, "openwiki", ".last-update.json"),
    `${JSON.stringify({
      updatedAt: new Date().toISOString(),
      command: "update",
      gitHead,
      model: "test-model",
      ...extraFields,
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

  test("does not skip a clean update that requests a different language", async () => {
    const repo = await createRepoWithOpenWiki();
    const head = await git(repo, ["rev-parse", "HEAD"]);
    await writeLastUpdate(repo, head, { language: "en" });

    const status = await getUpdateNoopStatus(repo, undefined, "fr");

    expect(status).toEqual({
      shouldSkip: false,
      reason: "output language changed",
    });
  });

  test("still skips an equivalent primary-language request", async () => {
    const repo = await createRepoWithOpenWiki();
    const head = await git(repo, ["rev-parse", "HEAD"]);
    await writeLastUpdate(repo, head, { language: "en" });

    const status = await getUpdateNoopStatus(repo, undefined, "en-GB");

    expect(status.shouldSkip).toBe(true);
  });

  test("detects a no-op when only the committed run metadata is dirty", async () => {
    // A committed wiki leaves openwiki/.last-update.json tracked, so the next
    // run sees it as an unstaged modification: " M openwiki/.last-update.json".
    const repo = await createRepoWithOpenWiki();
    await writeLastUpdate(repo, "0".repeat(40));
    await git(repo, ["add", "openwiki/.last-update.json"]);
    await git(repo, ["commit", "-m", "record update"]);
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

  test("skips update when worktree changes only touch ignored paths", async () => {
    const repo = await createRepoWithOpenWiki();
    const head = await git(repo, ["rev-parse", "HEAD"]);
    await writeLastUpdate(repo, head);
    await mkdir(path.join(repo, "private"));
    await writeFile(
      path.join(repo, "private", "notes.md"),
      "Ignored\n",
      "utf8",
    );

    const status = await getUpdateNoopStatus(
      repo,
      OpenWikiIgnore.parse("private/\n"),
    );

    expect(status.shouldSkip).toBe(true);
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

  test("does not skip update when the previous run was interrupted", async () => {
    const repo = await createRepoWithOpenWiki();
    const head = await git(repo, ["rev-parse", "HEAD"]);
    await writeLastUpdate(repo, head, { status: "interrupted" });

    const status = await getUpdateNoopStatus(repo);

    expect(status).toEqual({
      shouldSkip: false,
      reason: "previous update was interrupted",
    });
  });

  test("skips update when the previous complete run predates the status field", async () => {
    // Metadata written by versions without the status field must keep
    // behaving as a completed run and not force a spurious re-run.
    const repo = await createRepoWithOpenWiki();
    const head = await git(repo, ["rev-parse", "HEAD"]);
    await writeLastUpdate(repo, head);

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
