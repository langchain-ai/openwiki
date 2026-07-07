import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  createOpenWikiContentSnapshot,
  getUpdateNoopStatus,
  shouldCheckUpdateNoop,
  writeLastUpdateMetadata,
} from "../src/agent/utils.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function createRepoWithOpenWiki(
  openWikiDir = "openwiki",
): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "openwiki-noop-"));
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "OpenWiki Test"]);
  await writeFile(path.join(repo, "README.md"), "# Test Repo\n", "utf8");
  await mkdir(path.join(repo, openWikiDir), { recursive: true });
  await writeFile(
    path.join(repo, openWikiDir, "quickstart.md"),
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
  openWikiDir = "openwiki",
): Promise<void> {
  await writeFile(
    path.join(repo, openWikiDir, ".last-update.json"),
    `${JSON.stringify({
      updatedAt: new Date().toISOString(),
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

  test("skips update when commits only touch a configured docs directory", async () => {
    const openWikiDir = "docs/openwiki";
    const repo = await createRepoWithOpenWiki(openWikiDir);
    const head = await git(repo, ["rev-parse", "HEAD"]);
    await writeLastUpdate(repo, head, openWikiDir);
    await writeFile(
      path.join(repo, openWikiDir, "quickstart.md"),
      "# Quickstart\nUpdated\n",
      "utf8",
    );
    await git(repo, ["add", `${openWikiDir}/quickstart.md`]);
    await git(repo, ["commit", "-m", "update configured docs"]);

    const status = await getUpdateNoopStatus(repo, openWikiDir);

    expect(status.shouldSkip).toBe(true);
  });

  test("does not skip update when commits touch the default docs directory but another docs directory is configured", async () => {
    const openWikiDir = "docs/openwiki";
    const repo = await createRepoWithOpenWiki(openWikiDir);
    const head = await git(repo, ["rev-parse", "HEAD"]);
    await writeLastUpdate(repo, head, openWikiDir);
    await mkdir(path.join(repo, "openwiki"));
    await writeFile(
      path.join(repo, "openwiki", "quickstart.md"),
      "# Old default docs\n",
      "utf8",
    );
    await git(repo, ["add", "openwiki/quickstart.md"]);
    await git(repo, ["commit", "-m", "update default docs"]);

    const status = await getUpdateNoopStatus(repo, openWikiDir);

    expect(status.shouldSkip).toBe(false);
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

describe("OpenWiki metadata and snapshots", () => {
  test("write metadata and snapshot the configured docs directory", async () => {
    const openWikiDir = "docs/openwiki";
    const repo = await createRepoWithOpenWiki(openWikiDir);
    const snapshotBefore = await createOpenWikiContentSnapshot(
      repo,
      openWikiDir,
    );

    await writeLastUpdateMetadata("update", repo, "test-model", openWikiDir);

    const snapshotAfter = await createOpenWikiContentSnapshot(
      repo,
      openWikiDir,
    );
    const metadata = JSON.parse(
      await readFile(path.join(repo, openWikiDir, ".last-update.json"), "utf8"),
    ) as { model?: string; command?: string };

    expect(snapshotAfter).toBe(snapshotBefore);
    expect(metadata.command).toBe("update");
    expect(metadata.model).toBe("test-model");
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
