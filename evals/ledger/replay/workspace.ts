import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WorktreeSafetyError } from "../core/errors.js";
import { assertContained } from "../core/paths.js";

/**
 * A disposable, isolated filesystem for one benchmark run. Everything LEDGER writes
 * lives under `root`, which is created beneath the OS temp directory and removed
 * on `dispose`.
 */
export interface Workspace {
  /**
   * Absolute path to the run's private root under the OS temp directory.
   */
  root: string;

  /**
   * Absolute path the Git worktree is created beneath.
   */
  worktreeParent: string;

  /**
   * Absolute path immutable artifact snapshots are written beneath.
   */
  artifactsRoot: string;

  /**
   * Remove the entire workspace. Safe to call more than once.
   */
  dispose(): Promise<void>;
}

/**
 * Assert that `target` resolves to a path inside `allowedRoot`, following
 * symlinks. This is the single guard every destructive filesystem or Git
 * operation in the eval must pass through. It resolves the realpath of the
 * target (or, when the target does not exist yet, the realpath of its parent
 * plus the basename) so a symlink cannot be used to escape the allowed root.
 *
 * @param allowedRoot - Absolute path the target must be contained by.
 * @param target - Absolute path to check.
 *
 * @throws WorktreeSafetyError when the resolved target is outside the root.
 */
export async function assertContainedByRealpath(
  allowedRoot: string,
  target: string,
): Promise<void> {
  await assertContained(
    allowedRoot,
    target,
    (resolvedTarget, resolvedRoot) =>
      new WorktreeSafetyError(
        `Refusing to operate on "${resolvedTarget}" outside allowed root "${resolvedRoot}".`,
      ),
  );
}

/**
 * Create a fresh, isolated workspace beneath the OS temp directory.
 *
 * @returns The workspace, with its directories already created.
 */
export async function createWorkspace(): Promise<Workspace> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ledger-"));
  const worktreeParent = path.join(root, "worktrees");
  const artifactsRoot = path.join(root, "artifacts");

  await mkdir(worktreeParent, { recursive: true });
  await mkdir(artifactsRoot, { recursive: true });

  return {
    root,
    worktreeParent,
    artifactsRoot,
    async dispose(): Promise<void> {
      // Guard: only ever remove a path we created under the OS temp directory.
      await assertContainedByRealpath(os.tmpdir(), root);
      // Worktrees under this root carry `.git` state git may still be flushing;
      // retry the recursive remove so a transient ENOTEMPTY/EBUSY under parallel
      // test load does not fail teardown.
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    },
  };
}
