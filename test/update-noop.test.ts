import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { getUpdateNoopStatus } from "../src/agent/utils.ts";

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

test("detects a clean update with unchanged HEAD as a no-op", async () => {
  const repo = await createRepoWithOpenWiki();
  const head = await git(repo, ["rev-parse", "HEAD"]);
  await writeFile(
    path.join(repo, "openwiki", ".last-update.json"),
    `${JSON.stringify({
      updatedAt: new Date().toISOString(),
      command: "update",
      gitHead: head,
      model: "test-model",
    })}\n`,
    "utf8",
  );

  const status = await getUpdateNoopStatus(repo);

  assert.equal(status.shouldSkip, true);
});

test("does not skip update when the worktree has uncommitted changes", async () => {
  const repo = await createRepoWithOpenWiki();
  const head = await git(repo, ["rev-parse", "HEAD"]);
  await writeFile(
    path.join(repo, "openwiki", ".last-update.json"),
    `${JSON.stringify({
      updatedAt: new Date().toISOString(),
      command: "update",
      gitHead: head,
      model: "test-model",
    })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(repo, "README.md"),
    "# Test Repo\nChanged\n",
    "utf8",
  );

  const status = await getUpdateNoopStatus(repo);

  assert.equal(status.shouldSkip, false);
});
