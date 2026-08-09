import { access, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { git } from "../replay/git.js";
import { loadBenchmark } from "./benchmark.js";
import { computeTransitions, obsoleteTargetsFor } from "./transitions.js";
import { getActiveFacts } from "./truth-ledger.js";

/**
 * Absolute path to the committed `deepagents-evolution` fixture, whose source
 * history ships as `repo.bundle` with a gitignored `repo/` working tree.
 */
const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../benchmarks/deepagents-evolution",
);

/**
 * The reconstructed working tree, removed after each test so the check-in stays
 * clean and every run exercises reconstruction from the bundle from scratch.
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

describe("loadBenchmark on the committed deepagents-evolution fixture", () => {
  afterEach(async () => {
    await rm(RECONSTRUCTED_REPO, { recursive: true, force: true });
  });

  test("loads the manifest and reconstructs the source from its bundle", async () => {
    // Start from a fresh checkout's state: only the bundle is present.
    await rm(RECONSTRUCTED_REPO, { recursive: true, force: true });

    const benchmark = await loadBenchmark(FIXTURE_DIR);

    expect(benchmark.name).toBe("deepagents-evolution");
    const ids = benchmark.trace.checkpoints.map((checkpoint) => checkpoint.id);
    expect(ids).toEqual(["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"]);
    expect(benchmark.ledger.facts).toHaveLength(14);

    // The gitignored working tree was rebuilt from the committed bundle.
    expect(await exists(path.join(RECONSTRUCTED_REPO, ".git"))).toBe(true);

    // Every pinned checkpoint SHA resolves to a real commit in the rebuilt repo,
    // so the replay can create a worktree at each checkpoint.
    for (const checkpoint of benchmark.trace.checkpoints) {
      expect(
        await git(RECONSTRUCTED_REPO, ["cat-file", "-t", checkpoint.commit]),
      ).toBe("commit");
    }

    // Every checkpoint has at least one active fact, so coverage is well-defined
    // throughout (validateBenchmark already enforces this; assert it explicitly
    // as a guard against a future ledger edit that leaves a checkpoint bare).
    for (const id of ids) {
      expect(getActiveFacts(benchmark, id).length).toBeGreaterThan(0);
    }
  });

  test("exercises all four maintenance dimensions across the trace", async () => {
    const benchmark = await loadBenchmark(FIXTURE_DIR);
    const ids = benchmark.trace.checkpoints.map((checkpoint) => checkpoint.id);

    let introduced = 0;
    let changed = 0;
    let removed = 0;
    let stable = 0;

    for (let i = 1; i < ids.length; i += 1) {
      const transitions = computeTransitions(benchmark, ids[i - 1], ids[i]);
      introduced += transitions.introduced.length;
      changed += transitions.changed.length;
      removed += transitions.removed.length;
      stable += transitions.stable.length;
    }

    // Discovery, correction, complete forgetting, and retention each occur at
    // least once, so no maintenance rate is left undefined for lack of data.
    expect(introduced).toBeGreaterThan(0);
    expect(changed).toBeGreaterThan(0);
    expect(removed).toBeGreaterThan(0);
    expect(stable).toBeGreaterThan(0);
  });

  test("removes then revives the structured system prompt with an identical statement", async () => {
    const benchmark = await loadBenchmark(FIXTURE_DIR);
    const factId = "structured-system-prompt";

    // T5 -> T6 removes the fact, producing a forgetting target for its prior
    // version: the wiki should drop the structured-prompt claim at T6.
    const intoT6 = computeTransitions(benchmark, "T5", "T6");
    expect(intoT6.removed.map((fact) => fact.factId)).toContain(factId);
    const removedTarget = obsoleteTargetsFor(intoT6).find(
      (target) => target.factId === factId,
    );
    expect(removedTarget).toBeDefined();

    // T6 -> T7 revives the fact as a fresh introduction.
    const intoT7 = computeTransitions(benchmark, "T6", "T7");
    const revived = intoT7.introduced.find((fact) => fact.factId === factId);
    expect(revived).toBeDefined();

    // The revived statement is byte-identical to the obsolete one. This is the
    // precondition the runner's revival filter relies on: it retires an obsolete
    // forgetting target once the same fact id is active again with the exact
    // obsolete statement, so coverage (which now wants the claim asserted) and
    // forgetting (which no longer chases it) do not contradict at T7 and T8.
    expect(revived?.statement).toBe(removedTarget?.obsoleteStatement);

    // The fact is genuinely absent at T6 and present at T0 and T7, so the
    // revive is a real gap, not a wording artifact.
    const activeAt = (id: string) =>
      getActiveFacts(benchmark, id).some((fact) => fact.factId === factId);
    expect(activeAt("T0")).toBe(true);
    expect(activeAt("T6")).toBe(false);
    expect(activeAt("T7")).toBe(true);
  });
});
