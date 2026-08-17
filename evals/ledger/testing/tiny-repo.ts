import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { git } from "../replay/git.js";

/**
 * One commit to create in a tiny repo: a message and the files to write before
 * committing (paths relative to the repo root).
 */
export interface TinyCommit {
  /**
   * The commit message.
   */
  message: string;

  /**
   * File contents to write, keyed by repo-relative path, before this commit.
   */
  files: Record<string, string>;
}

/**
 * A built throwaway repository: its path, the SHAs of the commits created in
 * order, and a disposer.
 */
export interface TinyRepo {
  /**
   * Absolute path to the repository.
   */
  repoPath: string;

  /**
   * Full commit SHAs, one per input commit, in order.
   */
  shas: string[];

  /**
   * Remove the repository from disk.
   */
  dispose(): Promise<void>;
}

/**
 * Build an isolated Git repository under the OS temp directory with the given
 * commits. Identity and signing are pinned via per-command `-c` flags so the
 * build does not depend on the developer's Git config.
 *
 * @param commits - The commits to create, in order. Must be non-empty.
 *
 * @returns The built repository.
 */
export async function createTinyRepo(commits: TinyCommit[]): Promise<TinyRepo> {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "ledger-src-"));
  const identity = [
    "-c",
    "user.email=ledger@example.com",
    "-c",
    "user.name=LEDGER",
    "-c",
    "commit.gpgsign=false",
  ];

  await git(repoPath, ["-c", "init.defaultBranch=main", "init", "-q"]);

  const shas: string[] = [];

  for (const commit of commits) {
    for (const [relativePath, content] of Object.entries(commit.files)) {
      const absolute = path.join(repoPath, relativePath);

      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content, "utf8");
    }

    await git(repoPath, ["add", "-A"]);
    await git(repoPath, [...identity, "commit", "-q", "-m", commit.message]);
    shas.push(await git(repoPath, ["rev-parse", "HEAD"]));
  }

  return {
    repoPath,
    shas,
    async dispose(): Promise<void> {
      // Git can still be finalizing pack files under `.git/objects` when the
      // last command's promise resolves, which makes a bare recursive rmdir
      // race to ENOTEMPTY under parallel test load. maxRetries/retryDelay make
      // fs.rm retry exactly that class of transient error.
      await rm(repoPath, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    },
  };
}
