import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { diffSinceLastRun } from "../src/connectors/sources/git-repo.ts";

// `git diff --name-status HEAD` reports only uncommitted working-tree changes,
// so the manifest described the developer's dirty tree while ingestion presented
// it to the agent as the "changes since last run" window (issue #409). These run
// against a real repo — the whole bug was a wrong git invocation, so stubbing git
// would test the wrong thing.

const exec = promisify(execFile);

let repo: string;

async function git(...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd: repo });
  return stdout.trim();
}

async function commit(file: string, body: string): Promise<string> {
  await writeFile(path.join(repo, file), body, "utf8");
  await git("add", file);
  await git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", file);
  return git("rev-parse", "HEAD");
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "openwiki-gitrepo-"));
  await git("init", "-q", "-b", "main");
});

afterEach(async () => {
  await rm(repo, { force: true, recursive: true });
});

describe("diffSinceLastRun", () => {
  test("reports commits landed since the recorded head, not the dirty tree", async () => {
    const first = await commit("a.txt", "one");
    await commit("b.txt", "two");
    await commit("c.txt", "three");
    const head = await git("rev-parse", "HEAD");

    // An unrelated uncommitted edit that the old implementation would report.
    await writeFile(path.join(repo, "a.txt"), "locally edited", "utf8");

    const { changedFiles, resolvedPreviousHead } = await diffSinceLastRun(
      repo,
      head,
      first,
    );

    expect(resolvedPreviousHead).toBe(first);
    expect(changedFiles.join("\n")).toContain("b.txt");
    expect(changedFiles.join("\n")).toContain("c.txt");
    expect(changedFiles.join("\n")).not.toContain("a.txt");
  });

  test("an unchanged head means an empty window, not the dirty tree", async () => {
    await commit("a.txt", "one");
    const head = await git("rev-parse", "HEAD");
    await writeFile(path.join(repo, "a.txt"), "dirty", "utf8");

    const { changedFiles, resolvedPreviousHead } = await diffSinceLastRun(
      repo,
      head,
      head,
    );

    expect(changedFiles).toEqual([]);
    expect(resolvedPreviousHead).toBe(head);
  });

  test("first run with no recorded head falls back to the working tree", async () => {
    await commit("a.txt", "one");
    const head = await git("rev-parse", "HEAD");
    await writeFile(path.join(repo, "a.txt"), "dirty", "utf8");

    const { changedFiles, resolvedPreviousHead } = await diffSinceLastRun(
      repo,
      head,
      undefined,
    );

    expect(resolvedPreviousHead).toBeUndefined();
    expect(changedFiles.join("\n")).toContain("a.txt");
  });

  test("a recorded head that no longer resolves degrades instead of throwing", async () => {
    await commit("a.txt", "one");
    const head = await git("rev-parse", "HEAD");
    await writeFile(path.join(repo, "a.txt"), "dirty", "utf8");

    const { changedFiles, resolvedPreviousHead } = await diffSinceLastRun(
      repo,
      head,
      "0".repeat(40), // rebased / force-pushed / gc'd away
    );

    // No previousHead claimed, because the window could not be computed.
    expect(resolvedPreviousHead).toBeUndefined();
    expect(changedFiles.join("\n")).toContain("a.txt");
  });

  test("a rename is reported with its status code", async () => {
    const first = await commit("old.txt", "content");
    await git("mv", "old.txt", "new.txt");
    await git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "mv");
    const head = await git("rev-parse", "HEAD");

    const { changedFiles } = await diffSinceLastRun(repo, head, first);
    expect(changedFiles.join("\n")).toContain("new.txt");
  });
});
