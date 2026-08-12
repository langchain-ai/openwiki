import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  LedgerBenchmark,
  ObsoleteFactTarget,
  SurfaceItem,
} from "../../core/types.js";
import { validateEvidenceMapSources } from "../../benchmark/validation.js";
import {
  advanceObsoleteWatchSet,
  diffSurface,
  extractSurface,
  obsoleteTargetsFor,
} from "../../benchmark/surface.js";
import { git } from "../../replay/git.js";

/**
 * The model-free half of the taskflow v2 trap matrix. This never calls a model:
 * it loads the committed `repo.bundle`, extracts the deterministic public surface
 * at each of the five checkpoints, and asserts the exact introduced / changed /
 * removed / stable buckets, the forgetting watch-set carry, the one-checkpoint
 * RedisStore revert, and the TaskError resurrection statement-distinctness the
 * benchmark is built to exercise. It is the guard that a future edit to
 * `build-repo.mjs` cannot silently weaken a trap, and it pins the invariant that
 * the three signature-stable bug fixes stay invisible to the census.
 */

/**
 * One checkpoint's manifest entry: its id and pinned commit SHA.
 */
interface Checkpoint {
  /**
   * The checkpoint identifier, for example `T0`.
   */
  id: string;

  /**
   * The pinned commit SHA the surface is extracted at.
   */
  commit: string;
}

const benchmarkDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Index a surface by `factId` for concise per-item assertions.
 *
 * @param surface - The surface items to index.
 *
 * @returns The items keyed by `factId`.
 */
function byId(surface: SurfaceItem[]): Map<string, SurfaceItem> {
  return new Map(surface.map((item) => [item.factId, item]));
}

/**
 * The `factId`s of a transition bucket, for set-style assertions.
 *
 * @param bucket - Any array of items carrying a `factId`.
 *
 * @returns The `factId`s in the bucket.
 */
function factIds(bucket: Array<{ factId: string }>): string[] {
  return bucket.map((item) => item.factId);
}

describe("taskflow benchmark surface", () => {
  let workspace: string;
  let repoPath: string;
  let checkpoints: Checkpoint[];
  const surfaces = new Map<string, SurfaceItem[]>();
  const watchSets = new Map<string, ObsoleteFactTarget[]>();

  beforeAll(async () => {
    const manifest = JSON.parse(
      await readFile(path.join(benchmarkDir, "benchmark.json"), "utf8"),
    ) as Omit<LedgerBenchmark, "sourceRepoPath"> & { sourceRepo: string };
    checkpoints = manifest.trace.checkpoints;

    // Reconstruct the source repository from the committed bundle into a throwaway
    // workspace, so the test never depends on a locally reconstructed `repo/`.
    workspace = await mkdtemp(path.join(tmpdir(), "taskflow-surface-"));
    repoPath = path.join(workspace, "repo");
    await git(workspace, [
      "clone",
      "--quiet",
      path.join(benchmarkDir, "repo.bundle"),
      repoPath,
    ]);
    await validateEvidenceMapSources({ ...manifest, sourceRepoPath: repoPath });

    for (const checkpoint of checkpoints) {
      surfaces.set(
        checkpoint.id,
        await extractSurface(repoPath, checkpoint.commit),
      );
    }

    // Fold the forgetting watch set exactly as the runner does: diff each
    // boundary, retire nothing but revivals, and carry every other obsolete
    // version forward.
    let outstanding: ObsoleteFactTarget[] = [];
    for (let i = 1; i < checkpoints.length; i += 1) {
      const previous = surfaces.get(checkpoints[i - 1].id)!;
      const current = surfaces.get(checkpoints[i].id)!;
      const transitions = diffSurface(
        previous,
        current,
        checkpoints[i - 1].id,
        checkpoints[i].id,
      );
      outstanding = advanceObsoleteWatchSet({
        outstanding,
        surface: current,
        newlyObsolete: obsoleteTargetsFor(transitions),
      });
      watchSets.set(checkpoints[i].id, outstanding);
    }
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("every checkpoint yields a scorable surface", () => {
    for (const checkpoint of checkpoints) {
      expect(surfaces.get(checkpoint.id)!.length).toBeGreaterThan(0);
    }
  });

  test("T0 ships the honest MVP API and the version", () => {
    const ids = factIds(surfaces.get("T0")!);

    for (const id of [
      "symbol:Queue",
      "symbol:createQueue",
      "symbol:enqueue",
      "symbol:dequeue",
      "symbol:size",
      "symbol:Worker",
      "symbol:runWorker",
      "symbol:Task",
      "symbol:TaskState",
      "symbol:TaskError",
      "file:src/index.ts",
      "file:src/queue.ts",
      "file:src/task.ts",
      "file:src/worker.ts",
      "version",
    ]) {
      expect(ids).toContain(id);
    }

    // Symbols that only arrive later must be absent at T0.
    for (const id of [
      "symbol:Priority",
      "symbol:MemoryStore",
      "symbol:InMemoryStore",
      "symbol:RedisStore",
      "symbol:Scheduler",
      "symbol:TaskExecutionError",
      "symbol:clear",
    ]) {
      expect(ids).not.toContain(id);
    }

    expect(byId(surfaces.get("T0")!).get("version")?.name).toBe("0.1.0");
  });

  describe("T0 to T1: FIFO fix, priorities, pool, store, transient clear", () => {
    let introduced: string[];
    let changed: string[];
    let removed: string[];
    let stable: string[];

    beforeAll(() => {
      const transitions = diffSurface(
        surfaces.get("T0")!,
        surfaces.get("T1")!,
        "T0",
        "T1",
      );
      introduced = factIds(transitions.introduced);
      changed = factIds(transitions.changed);
      removed = factIds(transitions.removed);
      stable = factIds(transitions.stable);
    });

    test("introduces only the Priority enum, MemoryStore, and its file", () => {
      expect(introduced.sort()).toEqual([
        "file:src/store.ts",
        "symbol:MemoryStore",
        "symbol:Priority",
      ]);
    });

    test("changes the two grown signatures and the version", () => {
      for (const id of ["symbol:enqueue", "symbol:runWorker", "version"]) {
        expect(changed).toContain(id);
      }
    });

    test("removes nothing across the T1 boundary", () => {
      expect(removed).toEqual([]);
    });

    test("the FIFO bug fix and the priority reorder stay census-invisible", () => {
      // dequeue goes LIFO -> FIFO -> priority-ordered while its signature never
      // changes, and size and the queue file are untouched, so the census sees
      // them stable; the behavior flip is reachable only through precision.
      for (const id of [
        "symbol:dequeue",
        "symbol:size",
        "symbol:Queue",
        "symbol:createQueue",
        "symbol:Task",
        "symbol:Worker",
        "file:src/queue.ts",
      ]) {
        expect(stable).toContain(id);
      }
    });

    test("the transient clear never reaches the T1 surface", () => {
      expect(factIds(surfaces.get("T1")!)).not.toContain("symbol:clear");
    });
  });

  describe("T1 to T2: retries, events, pool fix, Store extraction + rename", () => {
    let introduced: string[];
    let changed: string[];
    let removed: string[];
    let stable: string[];

    beforeAll(() => {
      const transitions = diffSurface(
        surfaces.get("T1")!,
        surfaces.get("T2")!,
        "T1",
        "T2",
      );
      introduced = factIds(transitions.introduced);
      changed = factIds(transitions.changed);
      removed = factIds(transitions.removed);
      stable = factIds(transitions.stable);
    });

    test("introduces the retry, events, and pluggable-store surface", () => {
      for (const id of [
        "symbol:RetryPolicy",
        "symbol:RetryError",
        "symbol:withRetry",
        "symbol:TaskEvent",
        "symbol:EventBus",
        "symbol:subscribe",
        "symbol:publish",
        "symbol:Store",
        "symbol:InMemoryStore",
        "file:src/retry.ts",
        "file:src/events.ts",
        "file:src/store/store.ts",
        "file:src/store/in-memory-store.ts",
      ]) {
        expect(introduced).toContain(id);
      }
    });

    test("removes exactly the renamed MemoryStore and its old file", () => {
      expect(removed.sort()).toEqual([
        "file:src/store.ts",
        "symbol:MemoryStore",
      ]);
    });

    test("the worker-pool bug fix stays census-invisible", () => {
      // The pool goes from lockstep batches to per-slot streaming under an
      // identical runWorker signature, so it is precision-only.
      expect(stable).toContain("symbol:runWorker");
      expect(stable).toContain("file:src/worker.ts");
    });
  });

  describe("T2 to T3: scheduler, dead-letter, experimental Redis, rename", () => {
    let introduced: string[];
    let changed: string[];
    let removed: string[];
    let stable: string[];

    beforeAll(() => {
      const transitions = diffSurface(
        surfaces.get("T2")!,
        surfaces.get("T3")!,
        "T2",
        "T3",
      );
      introduced = factIds(transitions.introduced);
      changed = factIds(transitions.changed);
      removed = factIds(transitions.removed);
      stable = factIds(transitions.stable);
    });

    test("introduces the scheduler, dead-letter, experimental Redis, and renamed error", () => {
      for (const id of [
        "symbol:Scheduler",
        "symbol:createScheduler",
        "symbol:schedule",
        "symbol:DeadLetterQueue",
        "symbol:RedisStore",
        "symbol:TaskExecutionError",
        "file:src/scheduler.ts",
        "file:src/store/redis-store.ts",
      ]) {
        expect(introduced).toContain(id);
      }
    });

    test("changes the aliased TaskError and the version", () => {
      // TaskError becomes a deprecated re-export of TaskExecutionError, so its
      // one-line statement changes; the old class version drops out of the
      // surface and into the forgetting watch set.
      expect(changed).toContain("symbol:TaskError");
      expect(changed).toContain("version");
    });

    test("removes nothing across the T3 boundary", () => {
      expect(removed).toEqual([]);
    });

    test("the retry backoff bug fix stays census-invisible", () => {
      // withRetry's off-by-one exponent is fixed under an identical signature.
      expect(stable).toContain("symbol:withRetry");
      expect(stable).toContain("symbol:backoffDelay");
      expect(stable).toContain("file:src/retry.ts");
    });
  });

  describe("T3 to T4: the RedisStore revert, big-bang surface, resurrection", () => {
    let introduced: string[];
    let changed: string[];
    let removed: string[];

    beforeAll(() => {
      const transitions = diffSurface(
        surfaces.get("T3")!,
        surfaces.get("T4")!,
        "T3",
        "T4",
      );
      introduced = factIds(transitions.introduced);
      changed = factIds(transitions.changed);
      removed = factIds(transitions.removed);
    });

    test("introduces the metrics and persistence surface", () => {
      for (const id of [
        "symbol:SchedulerMetrics",
        "symbol:metrics",
        "symbol:PersistentQueue",
        "symbol:openPersistentQueue",
        "file:src/metrics.ts",
        "file:src/persistent-queue.ts",
      ]) {
        expect(introduced).toContain(id);
      }
    });

    test("removes exactly the reverted RedisStore and its file", () => {
      expect(removed.sort()).toEqual([
        "file:src/store/redis-store.ts",
        "symbol:RedisStore",
      ]);
    });

    test("changes the resurrected TaskError, the grown schedule signature, and the version", () => {
      for (const id of ["symbol:TaskError", "symbol:schedule", "version"]) {
        expect(changed).toContain(id);
      }
    });
  });

  describe("the RedisStore revert has a one-checkpoint knowledge lifetime", () => {
    test("the T3 RedisStore version is live at T3 and forgotten at T4", () => {
      const redisVersionId = byId(surfaces.get("T3")!).get(
        "symbol:RedisStore",
      )!.factVersionId;

      const watchedAt = (checkpointId: string): string[] =>
        watchSets.get(checkpointId)!.map((target) => target.factVersionId);

      // Introduced at T3 (never obsolete there), removed at T4 (now watched).
      expect(watchedAt("T3")).not.toContain(redisVersionId);
      expect(watchedAt("T4")).toContain(redisVersionId);
    });
  });

  describe("resurrection invariant: the buried TaskError stays under watch", () => {
    test("the T0 execution-error TaskError and the T4 validation-error TaskError are distinct versions", () => {
      const t0 = byId(surfaces.get("T0")!).get("symbol:TaskError")!;
      const t4 = byId(surfaces.get("T4")!).get("symbol:TaskError")!;

      expect(t0.statement).toContain("src/task.ts");
      expect(t4.statement).toContain("src/scheduler.ts");
      expect(t0.statement).not.toBe(t4.statement);
      expect(t0.factVersionId).not.toBe(t4.factVersionId);
    });

    test("the original execution-error version is never revived, so it stays watched at T3 and T4", () => {
      const originalVersionId = byId(surfaces.get("T0")!).get(
        "symbol:TaskError",
      )!.factVersionId;

      const watchedAt = (checkpointId: string): string[] =>
        watchSets.get(checkpointId)!.map((target) => target.factVersionId);

      // It becomes obsolete at T3 (renamed to TaskExecutionError) and is never
      // revived as the same statement, so it stays watched through T4.
      expect(watchedAt("T3")).toContain(originalVersionId);
      expect(watchedAt("T4")).toContain(originalVersionId);
    });
  });
});
