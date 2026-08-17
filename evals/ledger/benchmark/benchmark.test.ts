import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { git } from "../replay/git.js";
import { loadBenchmark } from "./benchmark.js";
import { extractSurface } from "./surface.js";

/**
 * Absolute path to the committed `calc` fixture, whose source history ships as
 * `repo.bundle` with a gitignored `repo/` working tree.
 */
const COMMITTED_FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../benchmarks/calc",
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

describe("loadBenchmark on the committed calc fixture", () => {
  let privateRoot: string;
  let fixtureDir: string;
  let reconstructedRepo: string;

  beforeEach(async () => {
    privateRoot = await mkdtemp(path.join(os.tmpdir(), "ledger-calc-fixture-"));
    fixtureDir = path.join(privateRoot, "calc");
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

    expect(benchmark.name).toBe("calc");
    expect(benchmark.difficulty).toBe("easy");
    expect(benchmark.evidenceMap?.entries.map((entry) => entry.id)).toEqual([
      "arithmetic-api",
      "library-properties",
      "release-version",
    ]);
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

  test("rejects a manifest whose difficulty is not easy, medium, or hard", async () => {
    const manifestPath = path.join(fixtureDir, "benchmark.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.difficulty = "trivial";
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    await expect(
      loadBenchmark(fixtureDir, { ensureSourceRepo: false }),
    ).rejects.toThrow(/difficulty/);
  });

  test("rejects an evidence selector absent from the entire trace", async () => {
    const manifestPath = path.join(fixtureDir, "benchmark.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.evidenceMap.entries[0].evidence = ["src/missing.ts#missing"];
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    await expect(loadBenchmark(fixtureDir)).rejects.toThrow(
      /does not resolve at any benchmark checkpoint/,
    );
  });

  test("loads benchmark truth without materializing source for evaluator replay", async () => {
    const benchmark = await loadBenchmark(fixtureDir, {
      ensureSourceRepo: false,
    });

    expect(benchmark.name).toBe("calc");
    expect(await exists(reconstructedRepo)).toBe(false);
  });

  test("extracts the evolving public surface at each checkpoint", async () => {
    const benchmark = await loadBenchmark(fixtureDir);
    const at = async (checkpointId: string) => {
      const checkpoint = benchmark.trace.checkpoints.find(
        (item) => item.id === checkpointId,
      );

      if (checkpoint === undefined) {
        throw new Error(`Unknown checkpoint "${checkpointId}".`);
      }

      return extractSurface(benchmark.sourceRepoPath, checkpoint.commit);
    };
    const t0 = await at("T0");
    const t1 = await at("T1");
    const t2 = await at("T2");
    const ids = (surface: Awaited<ReturnType<typeof at>>) =>
      surface.map((item) => item.factId);
    const version = (surface: Awaited<ReturnType<typeof at>>) =>
      surface.find((item) => item.factId === "version")?.name;

    // add is stable across the whole history; the version item is always present.
    for (const surface of [t0, t1, t2]) {
      expect(ids(surface)).toContain("symbol:add");
      expect(ids(surface)).toContain("version");
    }

    // subtract is introduced at T1, and negate is removed at T2.
    expect(ids(t0)).not.toContain("symbol:subtract");
    expect(ids(t1)).toContain("symbol:subtract");
    expect(ids(t0)).toContain("symbol:negate");
    expect(ids(t2)).not.toContain("symbol:negate");

    // The version string tracks the source constant across the bump.
    expect(version(t0)).toBe("1.0.0");
    expect(version(t2)).toBe("2.0.0");
  });
});
