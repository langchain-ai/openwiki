import { access } from "node:fs/promises";

import { BenchmarkValidationError } from "../core/errors.js";
import { assertContained } from "../core/paths.js";
import { git } from "../replay/git.js";

/**
 * Filename suffix of the committed Git bundle that carries a benchmark's source
 * history. A benchmark whose `sourceRepo` resolves to `<dir>/repo` ships its
 * history as `<dir>/repo.bundle`, so the working tree under `repo/` can stay
 * gitignored while the immutable, pinned commits remain tracked in one file.
 */
export const BUNDLE_SUFFIX = ".bundle";

/**
 * Whether a filesystem path currently exists (following symlinks).
 *
 * @param target - Absolute path to probe.
 *
 * @returns True when the path exists and is accessible.
 */
async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);

    return true;
  } catch {
    return false;
  }
}

/**
 * Assert that `target` resolves inside `benchmarkDir`, so a malformed
 * `sourceRepo` in an untrusted `benchmark.json` cannot direct a clone to write
 * outside the benchmark directory. `target` may not exist yet (it is the clone
 * destination), so when its realpath cannot be taken the parent's realpath is
 * resolved and the basename re-attached, closing a symlinked-parent escape.
 *
 * @param benchmarkDir - Absolute path the target must be contained by.
 * @param target - Absolute path to check.
 *
 * @throws BenchmarkValidationError when the resolved target escapes
 *   `benchmarkDir`.
 */
async function assertInsideBenchmarkDir(
  benchmarkDir: string,
  target: string,
): Promise<void> {
  await assertContained(
    benchmarkDir,
    target,
    (resolved, root) =>
      new BenchmarkValidationError(
        `Refusing to reconstruct a source repository at "${resolved}" outside the benchmark directory "${root}".`,
      ),
  );
}

/**
 * Ensure the benchmark's source repository exists on disk, reconstructing it
 * from a committed Git bundle when it is absent.
 *
 * A benchmark commits its source history as a single `<sourceRepo>.bundle` file
 * and gitignores the extracted `<sourceRepo>/` working tree. On a fresh checkout
 * the working tree is missing, so this clones the bundle back into place. Clone
 * preserves object SHAs, so the checkpoint commits pinned in `benchmark.json`
 * stay valid. The operation is:
 *
 * - Idempotent and non-destructive: it does nothing when the source path already
 *   exists, so a developer's local repository is never cloned over.
 * - A no-op when no bundle is present, leaving a benchmark that ships a real
 *   `sourceRepo/` directory to behave exactly as before.
 * - Contained: both the bundle and the clone destination are asserted to live
 *   inside `benchmarkDir` before Git runs, and the clone uses the `execFile`,
 *   `shell: false` Git helper, so a malformed `sourceRepo` cannot escape the
 *   benchmark directory or inject a shell command.
 *
 * @param benchmarkDir - Absolute path to the benchmark directory (the
 *   containment root).
 * @param sourceRepoPath - Absolute path the benchmark's `sourceRepo` resolved
 *   to.
 *
 * @throws BenchmarkValidationError when the bundle or destination would fall
 *   outside `benchmarkDir`.
 * @throws GitReplayError when the underlying `git clone` fails.
 */
export async function ensureSourceRepoAvailable(
  benchmarkDir: string,
  sourceRepoPath: string,
): Promise<void> {
  // Only ever reconstruct when the source is absent: an existing directory is
  // treated as authoritative and left untouched.
  if (await pathExists(sourceRepoPath)) {
    return;
  }

  const bundlePath = `${sourceRepoPath}${BUNDLE_SUFFIX}`;

  // No bundle means there is nothing to reconstruct; preserve prior behavior and
  // let the downstream replay surface a clear "not a Git repository" error.
  if (!(await pathExists(bundlePath))) {
    return;
  }

  await assertInsideBenchmarkDir(benchmarkDir, bundlePath);
  await assertInsideBenchmarkDir(benchmarkDir, sourceRepoPath);

  // Absolute paths passed as separate argv entries to the shell:false git
  // helper; the bundle is a local file, so no network fetch occurs.
  await git(benchmarkDir, ["clone", bundlePath, sourceRepoPath]);
}
