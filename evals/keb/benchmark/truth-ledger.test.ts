import { describe, expect, test } from "vitest";

import type { KebBenchmark } from "../core/types.js";
import { activeStatement, getActiveFacts } from "./truth-ledger.js";
import { computeTransitions, obsoleteTargetsFor } from "./transitions.js";

/**
 * A three-checkpoint benchmark exercising every version shape: a stable fact, a
 * fact that changes at T1, a fact introduced at T1, and a fact removed at T2.
 */
function fixture(): KebBenchmark {
  return {
    name: "fixture",
    description: "unit fixture",
    sourceRepoPath: "/nonexistent",
    trace: {
      checkpoints: [
        { id: "T0", commit: "aaaaaaa" },
        { id: "T1", commit: "bbbbbbb" },
        { id: "T2", commit: "ccccccc" },
      ],
    },
    ledger: {
      facts: [
        {
          id: "stable",
          versions: [{ statement: "always true", fromCheckpoint: "T0" }],
        },
        {
          id: "changing",
          versions: [
            { statement: "v1", fromCheckpoint: "T0", untilCheckpoint: "T1" },
            { statement: "v2", fromCheckpoint: "T1" },
          ],
        },
        {
          id: "introduced",
          versions: [{ statement: "born at T1", fromCheckpoint: "T1" }],
        },
        {
          id: "removed",
          versions: [
            {
              statement: "gone after T2",
              fromCheckpoint: "T0",
              untilCheckpoint: "T2",
            },
          ],
        },
      ],
    },
  };
}

/**
 * A three-checkpoint benchmark whose single fact changes at both boundaries, so
 * it goes obsolete twice on the trace. Used to prove each obsolete version keeps
 * a distinct id and the two are never conflated.
 */
function twiceChangedFixture(): KebBenchmark {
  return {
    name: "twice",
    description: "obsolete-twice fixture",
    sourceRepoPath: "/nonexistent",
    trace: {
      checkpoints: [
        { id: "T0", commit: "aaaaaaa" },
        { id: "T1", commit: "bbbbbbb" },
        { id: "T2", commit: "ccccccc" },
      ],
    },
    ledger: {
      facts: [
        {
          id: "evolving",
          versions: [
            { statement: "a", fromCheckpoint: "T0", untilCheckpoint: "T1" },
            { statement: "b", fromCheckpoint: "T1", untilCheckpoint: "T2" },
            { statement: "c", fromCheckpoint: "T2" },
          ],
        },
      ],
    },
  };
}

describe("getActiveFacts", () => {
  test("projects the correct active statements at T0", () => {
    const active = getActiveFacts(fixture(), "T0");

    expect(active.map((f) => [f.factId, f.statement])).toEqual([
      ["stable", "always true"],
      ["changing", "v1"],
      ["removed", "gone after T2"],
    ]);
  });

  test("projects the changed and introduced facts at T1", () => {
    const active = getActiveFacts(fixture(), "T1");

    expect(active.map((f) => [f.factId, f.statement])).toEqual([
      ["stable", "always true"],
      ["changing", "v2"],
      ["introduced", "born at T1"],
      ["removed", "gone after T2"],
    ]);
  });

  test("drops the removed fact at T2", () => {
    const active = getActiveFacts(fixture(), "T2");

    expect(active.map((f) => f.factId)).toEqual([
      "stable",
      "changing",
      "introduced",
    ]);
  });

  test("defaults the category during projection", () => {
    expect(getActiveFacts(fixture(), "T0")[0].category).toBe("uncategorized");
  });

  test("derives a stable factVersionId from the version's fromCheckpoint", () => {
    const versionId = (
      facts: { factId: string; factVersionId: string }[],
      id: string,
    ): string | undefined => facts.find((f) => f.factId === id)?.factVersionId;
    const t0 = getActiveFacts(fixture(), "T0");
    const t1 = getActiveFacts(fixture(), "T1");

    expect(versionId(t0, "stable")).toBe("stable@T0");
    expect(versionId(t1, "stable")).toBe("stable@T0");
    expect(versionId(t0, "changing")).toBe("changing@T0");
    expect(versionId(t1, "changing")).toBe("changing@T1");
  });
});

describe("activeStatement", () => {
  test("returns undefined for a fact not yet active", () => {
    const [introduced] = fixture().ledger.facts.filter(
      (f) => f.id === "introduced",
    );

    expect(activeStatement(fixture(), introduced, "T0")).toBeUndefined();
    expect(activeStatement(fixture(), introduced, "T1")).toBe("born at T1");
  });

  test("keeps a version active up to but excluding its untilCheckpoint", () => {
    const benchmark = fixture();
    const [removed] = benchmark.ledger.facts.filter((f) => f.id === "removed");

    // "removed" is [T0, T2): active at T0 and T1, gone exactly at the exclusive
    // untilCheckpoint T2. This is the half-open boundary the projection rests on.
    expect(activeStatement(benchmark, removed, "T0")).toBe("gone after T2");
    expect(activeStatement(benchmark, removed, "T1")).toBe("gone after T2");
    expect(activeStatement(benchmark, removed, "T2")).toBeUndefined();
  });
});

describe("computeTransitions", () => {
  test("classifies every boundary bucket from T0 to T1", () => {
    const t = computeTransitions(fixture(), "T0", "T1");

    expect(t.checkpointId).toBe("T1");
    expect(t.previousCheckpointId).toBe("T0");
    expect(t.introduced.map((f) => f.factId)).toEqual(["introduced"]);
    expect(t.changed.map((f) => f.factId)).toEqual(["changing"]);
    expect(t.removed).toEqual([]);
    // "stable" and "removed" are both unchanged across this boundary.
    expect(t.stable.map((f) => f.factId)).toEqual(["stable", "removed"]);
  });

  test("carries stable version ids on a changed fact", () => {
    const t = computeTransitions(fixture(), "T0", "T1");

    expect(t.changed).toEqual([
      {
        factId: "changing",
        previousVersionId: "changing@T0",
        previousStatement: "v1",
        currentVersionId: "changing@T1",
        currentStatement: "v2",
      },
    ]);
  });

  test("marks the removed fact removed from T1 to T2", () => {
    const t = computeTransitions(fixture(), "T1", "T2");

    expect(t.removed).toEqual([
      {
        factId: "removed",
        previousVersionId: "removed@T0",
        previousStatement: "gone after T2",
      },
    ]);
  });
});

describe("obsoleteTargetsFor", () => {
  test("yields the old version of a changed fact at T0 to T1", () => {
    const targets = obsoleteTargetsFor(
      computeTransitions(fixture(), "T0", "T1"),
    );

    expect(targets).toEqual([
      {
        factId: "changing",
        factVersionId: "changing@T0",
        obsoleteStatement: "v1",
      },
    ]);
  });

  test("yields the removed fact's obsolete version at T1 to T2", () => {
    const targets = obsoleteTargetsFor(
      computeTransitions(fixture(), "T1", "T2"),
    );

    expect(targets).toContainEqual({
      factId: "removed",
      factVersionId: "removed@T0",
      obsoleteStatement: "gone after T2",
    });
  });

  test("assigns a distinct obsolete id each time one fact goes obsolete", () => {
    const benchmark = twiceChangedFixture();
    const first = obsoleteTargetsFor(computeTransitions(benchmark, "T0", "T1"));
    const second = obsoleteTargetsFor(
      computeTransitions(benchmark, "T1", "T2"),
    );

    expect(first).toEqual([
      {
        factId: "evolving",
        factVersionId: "evolving@T0",
        obsoleteStatement: "a",
      },
    ]);
    expect(second).toEqual([
      {
        factId: "evolving",
        factVersionId: "evolving@T1",
        obsoleteStatement: "b",
      },
    ]);
    // The same logical fact going obsolete twice is never conflated: each
    // boundary reports its own version id.
    expect(first[0].factVersionId).not.toBe(second[0].factVersionId);
  });
});
