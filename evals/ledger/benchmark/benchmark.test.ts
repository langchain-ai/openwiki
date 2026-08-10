import { access, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { git } from "../replay/git.js";
import { loadBenchmark } from "./benchmark.js";
import { getActiveFacts } from "./truth-ledger.js";

/**
 * Absolute path to the committed `calc-evolution` fixture, whose source history
 * ships as `repo.bundle` with a gitignored `repo/` working tree.
 */
const COMMITTED_FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../benchmarks/calc-evolution",
);

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
  let privateRoot: string;
  let fixtureDir: string;
  let reconstructedRepo: string;

  beforeEach(async () => {
    privateRoot = await mkdtemp(path.join(os.tmpdir(), "ledger-calc-fixture-"));
    fixtureDir = path.join(privateRoot, "calc-evolution");
    reconstructedRepo = path.join(fixtureDir, "repo");

    await mkdir(fixtureDir, { recursive: true });
    await Promise.all([
      copyFile(
        path.join(COMMITTED_FIXTURE_DIR, "benchmark.json"),
        path.join(fixtureDir, "benchmark.json"),
      ),
      copyFile(
        path.join(COMMITTED_FIXTURE_DIR, "repo.bundle"),
        path.join(fixtureDir, "repo.bundle"),
      ),
    ]);
  });

  afterEach(async () => {
    await rm(privateRoot, { recursive: true, force: true });
  });

  test("loads the manifest and reconstructs the source from its bundle", async () => {
    const benchmark = await loadBenchmark(fixtureDir);

    expect(benchmark.name).toBe("calc-evolution");
    const ids = benchmark.trace.checkpoints.map((checkpoint) => checkpoint.id);
    expect(ids).toEqual(["T0", "T1", "T2"]);

    // The gitignored working tree was rebuilt from the committed bundle.
    expect(await exists(path.join(reconstructedRepo, ".git"))).toBe(true);

    // Every pinned checkpoint SHA resolves to a real commit in the rebuilt repo,
    // so the replay can create a worktree at each checkpoint.
    for (const checkpoint of benchmark.trace.checkpoints) {
      expect(
        await git(reconstructedRepo, ["cat-file", "-t", checkpoint.commit]),
      ).toBe("commit");
    }
  });

  test("loads benchmark truth without materializing source for evaluator replay", async () => {
    const benchmark = await loadBenchmark(fixtureDir, {
      ensureSourceRepo: false,
    });

    expect(benchmark.name).toBe("calc-evolution");
    expect(await exists(reconstructedRepo)).toBe(false);
  });

  test("projects material requirements at each checkpoint", async () => {
    const benchmark = await loadBenchmark(fixtureDir);
    const t0 = getActiveFacts(benchmark, "T0");
    const t1 = getActiveFacts(benchmark, "T1");
    const t2 = getActiveFacts(benchmark, "T2");

    expect([t0.length, t1.length, t2.length]).toEqual([5, 6, 5]);
    expect(
      t0.find((fact) => fact.factId === "current-version")?.statement,
    ).toContain("1.0.0");
    expect(
      t1.find((fact) => fact.factId === "subtract-operation")?.statement,
    ).toContain("a - b");
    expect(
      t2.find((fact) => fact.factId === "current-version")?.statement,
    ).toContain("2.0.0");
    expect(t2.some((fact) => fact.factId === "negate-operation")).toBe(false);
  });
});
