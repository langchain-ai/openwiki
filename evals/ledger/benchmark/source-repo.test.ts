import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { BenchmarkValidationError } from "../core/errors.js";
import { git } from "../replay/git.js";
import { createTinyRepo, type TinyRepo } from "../testing/tiny-repo.js";
import { BUNDLE_SUFFIX, ensureSourceRepoAvailable } from "./source-repo.js";

/**
 * Whether a path exists, mirroring the private probe in the module under test so
 * assertions can check reconstruction outcomes without importing internals.
 *
 * @param target - Absolute path to probe.
 *
 * @returns True when the path is accessible.
 */
async function exists(target: string): Promise<boolean> {
  try {
    await access(target);

    return true;
  } catch {
    return false;
  }
}

describe("ensureSourceRepoAvailable", () => {
  let benchmarkDir: string;
  let source: TinyRepo;

  beforeEach(async () => {
    benchmarkDir = await mkdtemp(path.join(os.tmpdir(), "ledger-bench-"));
    // A throwaway repo whose history we bundle into the benchmark directory; it
    // stands in for the source repository a benchmark commits as `repo.bundle`.
    source = await createTinyRepo([
      { message: "one", files: { "a.txt": "1" } },
      { message: "two", files: { "a.txt": "2" } },
    ]);
  });

  afterEach(async () => {
    await source.dispose();
    await rm(benchmarkDir, { recursive: true, force: true });
  });

  /**
   * Write a bundle of `source` to `<benchmarkDir>/<name><BUNDLE_SUFFIX>`, the
   * exact location `ensureSourceRepoAvailable` reconstructs from.
   */
  async function bundleInto(name: string): Promise<string> {
    const bundlePath = path.join(benchmarkDir, `${name}${BUNDLE_SUFFIX}`);

    await git(source.repoPath, [
      "bundle",
      "create",
      bundlePath,
      "main",
      "HEAD",
    ]);

    return bundlePath;
  }

  test("reconstructs the source from a committed bundle, preserving SHAs", async () => {
    await bundleInto("repo");
    const sourceRepoPath = path.join(benchmarkDir, "repo");

    expect(await exists(sourceRepoPath)).toBe(false);

    await ensureSourceRepoAvailable(benchmarkDir, sourceRepoPath);

    expect(await exists(path.join(sourceRepoPath, ".git"))).toBe(true);
    // Clone preserves object SHAs, so the pinned checkpoint commits remain valid
    // in the reconstructed repository.
    for (const sha of source.shas) {
      expect(await git(sourceRepoPath, ["cat-file", "-t", sha])).toBe("commit");
    }
  });

  test("does nothing when the source directory already exists", async () => {
    await bundleInto("repo");
    const sourceRepoPath = path.join(benchmarkDir, "repo");

    // A pre-existing source directory with a sentinel file that a clone would
    // never produce; it must survive untouched.
    await mkdir(sourceRepoPath, { recursive: true });
    const sentinel = path.join(sourceRepoPath, "sentinel.txt");
    await writeFile(sentinel, "local", "utf8");

    await ensureSourceRepoAvailable(benchmarkDir, sourceRepoPath);

    expect(await exists(sentinel)).toBe(true);
    expect(await exists(path.join(sourceRepoPath, ".git"))).toBe(false);
  });

  test("is a no-op when neither the source nor a bundle is present", async () => {
    const sourceRepoPath = path.join(benchmarkDir, "repo");

    await ensureSourceRepoAvailable(benchmarkDir, sourceRepoPath);

    expect(await exists(sourceRepoPath)).toBe(false);
  });

  test("refuses to reconstruct outside the benchmark directory", async () => {
    // A source path that escapes the benchmark directory, with a bundle sitting
    // at the escaping location so the containment guard is what stops it.
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "ledger-out-"));
    const sourceRepoPath = path.join(outsideRoot, "repo");
    await git(source.repoPath, [
      "bundle",
      "create",
      `${sourceRepoPath}${BUNDLE_SUFFIX}`,
      "main",
      "HEAD",
    ]);

    try {
      await expect(
        ensureSourceRepoAvailable(benchmarkDir, sourceRepoPath),
      ).rejects.toBeInstanceOf(BenchmarkValidationError);
      expect(await exists(sourceRepoPath)).toBe(false);
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
