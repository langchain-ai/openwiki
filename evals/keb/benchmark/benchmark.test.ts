import { access, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { git } from "../replay/git.js";
import { loadBenchmark } from "./benchmark.js";

/**
 * Absolute path to the committed `calc-evolution` fixture, whose source history
 * ships as `repo.bundle` with a gitignored `repo/` working tree.
 */
const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../benchmarks/calc-evolution",
);

/**
 * The reconstructed working tree, removed after each test so the check-in stays
 * clean and every run exercises reconstruction from scratch.
 */
const RECONSTRUCTED_REPO = path.join(FIXTURE_DIR, "repo");

/**
 * Whether a path exists.
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

describe("loadBenchmark on the committed calc-evolution fixture", () => {
  afterEach(async () => {
    await rm(RECONSTRUCTED_REPO, { recursive: true, force: true });
  });

  test("loads the manifest and reconstructs the source from its bundle", async () => {
    // Start from a fresh checkout's state: only the bundle is present.
    await rm(RECONSTRUCTED_REPO, { recursive: true, force: true });

    const benchmark = await loadBenchmark(FIXTURE_DIR);

    expect(benchmark.name).toBe("calc-evolution");
    const ids = benchmark.trace.checkpoints.map((checkpoint) => checkpoint.id);
    expect(ids).toEqual(["T0", "T1", "T2"]);

    // The gitignored working tree was rebuilt from the committed bundle.
    expect(await exists(path.join(RECONSTRUCTED_REPO, ".git"))).toBe(true);

    // Every pinned checkpoint SHA resolves to a real commit in the rebuilt repo,
    // so the replay can create a worktree at each checkpoint.
    for (const checkpoint of benchmark.trace.checkpoints) {
      expect(
        await git(RECONSTRUCTED_REPO, ["cat-file", "-t", checkpoint.commit]),
      ).toBe("commit");
    }
  });
});
