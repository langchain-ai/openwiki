import { realpath } from "node:fs/promises";
import path from "node:path";

import { GitReplayError } from "../core/errors.js";
import { assertValidCommitSha, git } from "./git.js";
import { OPEN_WIKI_DIR } from "../core/paths.js";
import { assertContainedByRealpath } from "./workspace.js";

/**
 * Drives a source repository through an evolution trace inside one detached Git
 * worktree. Both a private local clone and the worktree are created under a
 * caller-provided temp parent; the class records their realpaths and confines
 * every destructive operation to them. The private clone ensures a running
 * replay does not depend on mutable Git administration files in the benchmark
 * fixture.
 *
 * The generated wiki lives as untracked files inside the worktree, so
 * `checkout` (which never touches untracked files) preserves it from one
 * checkpoint to the next. `GitReplay` therefore never runs `git clean`, which
 * would delete the wiki and defeat longitudinal updates.
 */
export class GitReplay {
  /**
   * Absolute realpath of the private source clone being replayed.
   */
  private readonly sourceRepoPath: string;

  /**
   * Absolute realpath of the worktree this instance created and owns.
   */
  private readonly worktreeRoot: string;

  private constructor(sourceRepoPath: string, worktreeRoot: string) {
    this.sourceRepoPath = sourceRepoPath;
    this.worktreeRoot = worktreeRoot;
  }

  /**
   * Absolute path to the checked-out worktree. This is the `cwd` the System
   * Under Test is run against.
   */
  get worktreeDir(): string {
    return this.worktreeRoot;
  }

  /**
   * Create a private local clone and a detached worktree at the initial commit.
   *
   * @param sourceRepoPath - Absolute path to the source repository.
   * @param worktreeParent - Absolute path (inside a workspace) to create the
   *   worktree beneath.
   * @param initialCommit - Commit SHA the worktree starts at.
   *
   * @returns A ready `GitReplay` independent of later source-path changes.
   *
   * @throws GitReplayError when the source is not a Git repository or the commit
   *   is missing.
   */
  static async create(
    sourceRepoPath: string,
    worktreeParent: string,
    initialCommit: string,
  ): Promise<GitReplay> {
    assertValidCommitSha(initialCommit);

    const source = await realpath(sourceRepoPath);

    try {
      await git(source, ["rev-parse", "--is-inside-work-tree"]);
    } catch {
      throw new GitReplayError(
        `Source path is not a Git repository: ${sourceRepoPath}`,
      );
    }

    const privateSourcePath = path.join(worktreeParent, "source");
    const worktreePath = path.join(worktreeParent, "wt");

    // Containment sanity checks before creating anything: the private clone and
    // worktree must both land inside the workspace-owned parent.
    await assertContainedByRealpath(worktreeParent, privateSourcePath);
    await assertContainedByRealpath(worktreeParent, worktreePath);

    // A local clone has independent Git administration metadata. Its object
    // hardlinks remain valid if the original fixture directory is later removed,
    // while avoiding a redundant copy of immutable benchmark history.
    await git(worktreeParent, [
      "clone",
      "--local",
      "--no-checkout",
      source,
      privateSourcePath,
    ]);
    const privateSource = await realpath(privateSourcePath);

    await git(privateSource, [
      "worktree",
      "add",
      "--detach",
      worktreePath,
      initialCommit,
    ]);

    const worktreeRoot = await realpath(worktreePath);

    return new GitReplay(privateSource, worktreeRoot);
  }

  /**
   * Advance the worktree to a later checkpoint's commit. First discards any
   * modifications to tracked files with `git reset --hard HEAD`, so a System
   * Under Test that dirtied a tracked file cannot block the checkout, then checks
   * the commit out detached. Untracked files (the generated wiki) are preserved
   * by Git across both steps; this method never runs `git clean`.
   *
   * The `reset --hard` is destructive, so it is confined to the worktree root by
   * a realpath containment check first.
   *
   * @param commit - The checkpoint's commit SHA.
   *
   * @throws GitReplayError when the commit is invalid or missing.
   * @throws WorktreeSafetyError when containment cannot be proven.
   */
  async checkout(commit: string): Promise<void> {
    assertValidCommitSha(commit);
    await assertContainedByRealpath(this.worktreeRoot, this.worktreeRoot);
    await git(this.worktreeRoot, ["reset", "--hard", "HEAD"]);
    await git(this.worktreeRoot, ["checkout", "--detach", commit]);
  }

  /**
   * Assert that a checkpoint SHA resolves to a commit object in the source
   * repository. Guards against a benchmark that names a SHA which was never
   * fetched, was garbage-collected, or is a tag or tree rather than a commit.
   * The runner calls this for every checkpoint before the walk begins.
   * Read-only: it runs `git rev-parse` against the source and mutates nothing.
   *
   * @param commit - The checkpoint's commit SHA.
   *
   * @throws GitReplayError when the SHA does not resolve to a commit.
   */
  async assertCommitResolves(commit: string): Promise<void> {
    assertValidCommitSha(commit);

    try {
      await git(this.sourceRepoPath, [
        "rev-parse",
        "--verify",
        "--quiet",
        `${commit}^{commit}`,
      ]);
    } catch {
      throw new GitReplayError(
        `Benchmark checkpoint ${commit} does not resolve to a commit in the ` +
          `source repository.`,
      );
    }
  }

  /**
   * Assert that one commit is a Git ancestor of another. The runner calls this
   * for each adjacent checkpoint pair before the walk begins so the trace is a
   * forward-moving history and every `update` replays real intervening work
   * rather than an unrelated or backwards jump. Read-only: it runs
   * `git merge-base --is-ancestor` against the source and mutates nothing.
   *
   * @param ancestor - The earlier checkpoint's commit SHA.
   * @param descendant - The later checkpoint's commit SHA.
   *
   * @throws GitReplayError when `ancestor` is not an ancestor of `descendant`.
   */
  async assertAncestor(ancestor: string, descendant: string): Promise<void> {
    assertValidCommitSha(ancestor);
    assertValidCommitSha(descendant);

    try {
      await git(this.sourceRepoPath, [
        "merge-base",
        "--is-ancestor",
        ancestor,
        descendant,
      ]);
    } catch {
      throw new GitReplayError(
        `Benchmark checkpoint ${ancestor} is not a Git ancestor of ` +
          `${descendant}; checkpoints must form a forward-moving history.`,
      );
    }
  }

  /**
   * Assert that the source repository tracks nothing under `openwiki/` at the
   * given commit. LEDGER's longitudinal premise depends on `openwiki/` being
   * untracked so a checkout preserves the generated wiki; if a benchmark
   * checkpoint tracked `openwiki/`, the `reset --hard`/`checkout` in `checkout`
   * would overwrite or delete the artifact and silently corrupt the run. The
   * runner calls this for every checkpoint before the walk begins. Read-only:
   * it runs `git ls-tree` against the source and mutates nothing.
   *
   * @param commit - The checkpoint's commit SHA.
   *
   * @throws GitReplayError when the commit tracks any path under `openwiki/`.
   */
  async assertWikiNotTrackedAt(commit: string): Promise<void> {
    assertValidCommitSha(commit);

    const tracked = await git(this.sourceRepoPath, [
      "ls-tree",
      "-r",
      "--name-only",
      commit,
      "--",
      `${OPEN_WIKI_DIR}/`,
    ]);

    if (tracked.trim().length > 0) {
      throw new GitReplayError(
        `Benchmark checkpoint ${commit} tracks files under ${OPEN_WIKI_DIR}/. ` +
          `LEDGER requires ${OPEN_WIKI_DIR}/ to be untracked so the generated wiki ` +
          `survives checkout; remove it from the benchmark source history.`,
      );
    }
  }

  /**
   * Remove the worktree from the private source clone's worktree list. The
   * workspace owning both temporary trees is responsible for deleting their
   * files; this only unregisters the worktree. Failures are swallowed so
   * teardown never masks an earlier error.
   */
  async teardown(): Promise<void> {
    try {
      await assertContainedByRealpath(this.worktreeRoot, this.worktreeRoot);
      await git(this.sourceRepoPath, [
        "worktree",
        "remove",
        "--force",
        this.worktreeRoot,
      ]);
    } catch {
      // Best-effort. The workspace `dispose` removes the files regardless, and a
      // stray worktree entry is cleaned by a later `git worktree prune`.
    }
  }
}
