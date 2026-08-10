import { describe, expect, test } from "vitest";

import { computeChurn } from "./churn.js";
import {
  aggregateScore,
  computeCoverage,
  computeDiagnostics,
  computeEvaluationCompleteness,
  computeMaintenanceCounts,
  computePrecision,
  computeRecovery,
  computeStaleKnowledge,
} from "./metrics.js";
import type {
  ChangedFact,
  CheckpointEvaluationRecord,
  CheckpointScore,
  CheckpointTransitions,
  FactEvaluation,
  ForgettingEvaluation,
  IntroducedFact,
  KnowledgeArtifact,
  PrecisionAssertionEvaluation,
  RemovedFact,
  StableFact,
} from "../core/types.js";

function fact(
  factId: string,
  verdict: FactEvaluation["verdict"],
): FactEvaluation {
  return {
    factId,
    factVersionId: `${factId}@v`,
    verdict,
    evidence: [],
    rationale: "",
  };
}

function forget(
  factVersionId: string,
  verdict: ForgettingEvaluation["verdict"],
): ForgettingEvaluation {
  const [factId] = factVersionId.split("@");

  return { factId, factVersionId, verdict, evidence: [], rationale: "" };
}

function assertion(
  verdict: PrecisionAssertionEvaluation["verdict"],
  adjudicatedBy: PrecisionAssertionEvaluation["adjudicatedBy"] = "none",
  tense: PrecisionAssertionEvaluation["tense"] = "current",
): PrecisionAssertionEvaluation {
  return {
    assertion: "x",
    location: "a.md",
    verdict,
    tense,
    adjudicatedBy,
    evidenceIds: [],
    rationale: "",
  };
}

function introduced(factId: string): IntroducedFact {
  return { factId, factVersionId: `${factId}@v`, statement: `${factId} now` };
}

function changed(factId: string, previousVersionId: string): ChangedFact {
  return {
    factId,
    previousVersionId,
    previousStatement: `${factId} old`,
    currentVersionId: `${factId}@v`,
    currentStatement: `${factId} now`,
  };
}

function removed(factId: string, previousVersionId: string): RemovedFact {
  return { factId, previousVersionId, previousStatement: `${factId} old` };
}

function stable(factId: string): StableFact {
  return { factId, factVersionId: `${factId}@v`, statement: `${factId} now` };
}

function transitionsAt(
  checkpointId: string,
  overrides: Partial<CheckpointTransitions>,
): CheckpointTransitions {
  return {
    checkpointId,
    previousCheckpointId: "prev",
    introduced: [],
    changed: [],
    removed: [],
    stable: [],
    ...overrides,
  };
}

function base(checkpointId: string): CheckpointEvaluationRecord {
  return { checkpointId, factEvaluations: [], forgettingEvaluations: [] };
}

describe("computeCoverage", () => {
  test("is strict: only correct earns headline credit", () => {
    const metric = computeCoverage([
      fact("a", "correct"),
      fact("b", "partial"),
      fact("c", "missing"),
      fact("d", "contradicted"),
    ]);

    expect(metric).toEqual({
      correct: 1,
      partial: 1,
      missing: 1,
      contradicted: 1,
      indeterminate: 0,
      total: 4,
      score: 0.25,
    });
  });

  test("defensively scores an empty fact set as 0 (validation rejects it upstream)", () => {
    // A zero-active-fact checkpoint is invalid benchmark data that
    // validateBenchmark rejects before any run, so this branch is unreachable in
    // scoring; the guard exists only so the pure function never divides by zero.
    expect(computeCoverage([]).score).toBe(0);
  });

  test("excludes indeterminate evaluator output from the semantic denominator", () => {
    const metric = computeCoverage([
      fact("valid", "correct"),
      fact("broken", "indeterminate"),
    ]);

    expect(metric).toMatchObject({
      correct: 1,
      indeterminate: 1,
      total: 2,
      score: 1,
    });
  });
});

describe("computePrecision", () => {
  test("scores supported claims over adjudicated claims", () => {
    const metric = computePrecision([
      assertion("supported", "ledger"),
      assertion("supported", "ledger"),
      assertion("invented", "source"),
      assertion("stale", "source"),
      assertion("unverified"),
    ]);

    expect(metric).toEqual({
      supported: 2,
      invented: 1,
      stale: 1,
      unverified: 1,
      adjudicated: 4,
      total: 5,
      hallucinationRate: 0.25,
      stalenessRate: 0.25,
      unverifiedRate: 0.2,
      score: 0.5,
    });
  });

  test("keeps unverified claims outside the precision denominator", () => {
    const metric = computePrecision([
      assertion("supported", "ledger"),
      assertion("invented", "source"),
      assertion("unverified"),
      assertion("unverified"),
    ]);

    expect(metric).toMatchObject({
      supported: 1,
      invented: 1,
      unverified: 2,
      adjudicated: 2,
      hallucinationRate: 0.5,
      unverifiedRate: 0.5,
      score: 0.5,
    });
  });

  test("returns null scored metrics for a wiki with no adjudicated claims", () => {
    expect(computePrecision([])).toEqual({
      supported: 0,
      invented: 0,
      stale: 0,
      unverified: 0,
      adjudicated: 0,
      total: 0,
      hallucinationRate: null,
      stalenessRate: null,
      unverifiedRate: 0,
      score: null,
    });

    expect(computePrecision([assertion("unverified")]).score).toBeNull();
  });
});

describe("computeEvaluationCompleteness", () => {
  test("keeps evaluator failures separate from four-class claim verdicts", () => {
    expect(
      computeEvaluationCompleteness(
        [fact("covered", "correct"), fact("broken", "indeterminate")],
        [assertion("unverified"), assertion("invented", "source")],
        [forget("old@T0", "forgotten")],
      ),
    ).toEqual({ judged: 4, indeterminate: 1, total: 5, score: 0.8 });
  });
});

describe("computeMaintenanceCounts", () => {
  const transitions: CheckpointTransitions = {
    checkpointId: "T1",
    previousCheckpointId: "T0",
    introduced: [{ factId: "n", factVersionId: "n@T1", statement: "x" }],
    changed: [
      {
        factId: "c",
        previousVersionId: "c@T0",
        previousStatement: "old",
        currentVersionId: "c@T1",
        currentStatement: "new",
      },
    ],
    removed: [
      { factId: "r", previousVersionId: "r@T0", previousStatement: "gone" },
    ],
    stable: [{ factId: "s", factVersionId: "s@T0", statement: "x" }],
  };

  test("counts each rate's numerator and denominator", () => {
    const counts = computeMaintenanceCounts(
      transitions,
      [fact("n", "correct"), fact("c", "correct"), fact("s", "correct")],
      [forget("c@T0", "forgotten"), forget("r@T0", "forgotten")],
      [fact("s", "correct")],
    );

    expect(counts).toEqual({
      newKnowledgeDiscovery: { numerator: 1, denominator: 1 },
      changedKnowledgeCorrection: { numerator: 1, denominator: 1 },
      completeForgetting: { numerator: 1, denominator: 1 },
      stableRetention: { numerator: 1, denominator: 1 },
    });
  });

  test("correction needs both the new version correct and the old forgotten", () => {
    const counts = computeMaintenanceCounts(
      transitions,
      [fact("n", "missing"), fact("c", "correct"), fact("s", "correct")],
      [forget("c@T0", "lingering"), forget("r@T0", "lingering")],
      [fact("s", "correct")],
    );

    expect(counts.newKnowledgeDiscovery).toEqual({
      numerator: 0,
      denominator: 1,
    });
    // c reads correct now, but its obsolete version still lingers: no credit.
    expect(counts.changedKnowledgeCorrection).toEqual({
      numerator: 0,
      denominator: 1,
    });
    expect(counts.completeForgetting).toEqual({ numerator: 0, denominator: 1 });
    expect(counts.stableRetention).toEqual({ numerator: 1, denominator: 1 });
  });

  test("retention ranges only over facts correct at the previous checkpoint", () => {
    const counts = computeMaintenanceCounts(
      transitions,
      [fact("s", "correct")],
      [],
      [fact("s", "missing")],
    );

    expect(counts.stableRetention).toEqual({ numerator: 0, denominator: 0 });
  });

  test("retention counts an eligible stable fact that regresses as a miss", () => {
    const counts = computeMaintenanceCounts(
      transitions,
      [fact("s", "missing")],
      [],
      [fact("s", "correct")],
    );

    // "s" was correct at the previous checkpoint (eligible) but is missing now, so
    // it is in the denominator but not the numerator: a retention failure.
    expect(counts.stableRetention).toEqual({ numerator: 0, denominator: 1 });
  });

  test("excludes indeterminate evaluator output from maintenance denominators", () => {
    const counts = computeMaintenanceCounts(
      transitions,
      [
        fact("n", "indeterminate"),
        fact("c", "indeterminate"),
        fact("s", "indeterminate"),
      ],
      [forget("c@T0", "indeterminate"), forget("r@T0", "indeterminate")],
      [fact("s", "correct")],
    );

    expect(counts).toEqual({
      newKnowledgeDiscovery: { numerator: 0, denominator: 0 },
      changedKnowledgeCorrection: { numerator: 0, denominator: 0 },
      completeForgetting: { numerator: 0, denominator: 0 },
      stableRetention: { numerator: 0, denominator: 0 },
    });
  });
});

describe("aggregateScore", () => {
  test("macro-averages quality and globally aggregates maintenance", () => {
    const checkpoints: CheckpointScore[] = [
      {
        checkpointId: "T0",
        coverage: {
          correct: 1,
          partial: 0,
          missing: 0,
          contradicted: 0,
          indeterminate: 0,
          total: 1,
          score: 1,
        },
        precision: {
          supported: 1,
          invented: 0,
          stale: 0,
          unverified: 0,
          adjudicated: 1,
          total: 1,
          hallucinationRate: 0,
          stalenessRate: 0,
          unverifiedRate: 0,
          score: 1,
        },
        evaluationCompleteness: {
          judged: 2,
          indeterminate: 0,
          total: 2,
          score: 1,
        },
        efficiency: { durationMs: 0, skipped: false },
      },
      {
        checkpointId: "T1",
        coverage: {
          correct: 0,
          partial: 0,
          missing: 1,
          contradicted: 0,
          indeterminate: 0,
          total: 1,
          score: 0,
        },
        precision: {
          supported: 1,
          invented: 1,
          stale: 0,
          unverified: 0,
          adjudicated: 2,
          total: 2,
          hallucinationRate: 0.5,
          stalenessRate: 0,
          unverifiedRate: 0,
          score: 0.5,
        },
        evaluationCompleteness: {
          judged: 2,
          indeterminate: 1,
          total: 3,
          score: 2 / 3,
        },
        maintenanceCounts: {
          newKnowledgeDiscovery: { numerator: 1, denominator: 2 },
          changedKnowledgeCorrection: { numerator: 0, denominator: 0 },
          completeForgetting: { numerator: 1, denominator: 1 },
          stableRetention: { numerator: 2, denominator: 2 },
        },
        efficiency: { durationMs: 0, skipped: false },
      },
    ];

    const score = aggregateScore(checkpoints);

    // trace coverage = mean(1, 0) = 0.5; trace precision = mean(1, 0.5) = 0.75
    expect(score.traceCoverage).toBe(0.5);
    expect(score.tracePrecision).toBe(0.75);
    expect(score.traceHallucinationRate).toBe(0.25);
    expect(score.traceStalenessRate).toBe(0);
    expect(score.traceUnverifiedRate).toBe(0);
    expect(score.evaluationCompleteness).toBe(0.8);
    // quality = harmonic(0.5, 0.75) = 2 * 0.5 * 0.75 / 1.25 = 0.6
    expect(score.quality).toBeCloseTo(0.6, 10);
    // global rates: discovery 1/2; correction denom 0 -> undefined; forgetting 1/1; retention 2/2
    expect(score.maintenanceRates).toEqual({
      newKnowledgeDiscovery: 0.5,
      changedKnowledgeCorrection: undefined,
      completeForgetting: 1,
      stableRetention: 1,
    });
    // maintenance = mean(0.5, 1, 1) over the three defined rates
    expect(score.maintenance).toBeCloseTo(2.5 / 3, 10);
    expect(score.ledgerScore).toBeCloseTo((0.6 + 2.5 / 3) / 2, 10);
  });

  test("falls back to quality when the trace has no maintenance boundary", () => {
    const checkpoints: CheckpointScore[] = [
      {
        checkpointId: "T0",
        coverage: {
          correct: 1,
          partial: 0,
          missing: 0,
          contradicted: 0,
          indeterminate: 0,
          total: 1,
          score: 1,
        },
        precision: {
          supported: 1,
          invented: 0,
          stale: 0,
          unverified: 0,
          adjudicated: 1,
          total: 1,
          hallucinationRate: 0,
          stalenessRate: 0,
          unverifiedRate: 0,
          score: 1,
        },
        evaluationCompleteness: {
          judged: 2,
          indeterminate: 0,
          total: 2,
          score: 1,
        },
        efficiency: { durationMs: 0, skipped: false },
      },
    ];

    const score = aggregateScore(checkpoints);

    expect(score.quality).toBe(1);
    expect(score.maintenance).toBeUndefined();
    expect(score.maintenanceRates).toEqual({
      newKnowledgeDiscovery: undefined,
      changedKnowledgeCorrection: undefined,
      completeForgetting: undefined,
      stableRetention: undefined,
    });
    expect(score.ledgerScore).toBe(1);
  });

  test("excludes null precision checkpoints and returns null when none adjudicate", () => {
    const checkpoint: CheckpointScore = {
      checkpointId: "T0",
      coverage: {
        correct: 1,
        partial: 0,
        missing: 0,
        contradicted: 0,
        indeterminate: 0,
        total: 1,
        score: 1,
      },
      precision: computePrecision([assertion("unverified")]),
      evaluationCompleteness: {
        judged: 2,
        indeterminate: 0,
        total: 2,
        score: 1,
      },
      efficiency: { durationMs: 0, skipped: false },
    };

    expect(aggregateScore([checkpoint])).toMatchObject({
      tracePrecision: null,
      traceHallucinationRate: null,
      traceStalenessRate: null,
      traceUnverifiedRate: 1,
      quality: null,
      ledgerScore: null,
    });
  });
});

describe("computeChurn", () => {
  const artifact = (
    checkpointId: string,
    docs: Array<[string, string]>,
  ): KnowledgeArtifact => ({
    checkpointId,
    snapshotDir: "/nonexistent",
    fingerprint: checkpointId,
    documents: docs.map(([relativePath, content]) => ({
      relativePath,
      content,
    })),
  });

  test("is undefined at the first checkpoint", () => {
    expect(
      computeChurn(undefined, artifact("T0", [["a.md", "x"]])),
    ).toBeUndefined();
  });

  test("counts added, removed, and changed lines across the union", () => {
    const previous = artifact("T0", [
      ["a.md", "one\ntwo\nthree"],
      ["gone.md", "old"],
    ]);
    const current = artifact("T1", [
      ["a.md", "one\ntwo\nfour"], // three -> four: 1 removed + 1 added
      ["new.md", "hi\nthere"], // 2 added
    ]);

    // a.md: 2, gone.md: 1 removed, new.md: 2 added -> 5
    expect(computeChurn(previous, current)).toBe(5);
  });

  test("is zero for identical artifacts", () => {
    const previous = artifact("T0", [
      ["a.md", "one\ntwo"],
      ["b.md", "x"],
    ]);
    const current = artifact("T1", [
      ["a.md", "one\ntwo"],
      ["b.md", "x"],
    ]);

    expect(computeChurn(previous, current)).toBe(0);
  });

  test("is order-insensitive: reordering a document's lines is no churn", () => {
    const previous = artifact("T0", [["a.md", "one\ntwo\nthree"]]);
    const current = artifact("T1", [["a.md", "three\none\ntwo"]]);

    // Same multiset of lines in a different order. This is the deliberate proxy:
    // a multiset symmetric difference, not an LCS edit distance, so a pure
    // reordering registers no churn.
    expect(computeChurn(previous, current)).toBe(0);
  });

  test("charges an added document exactly its line count, with no phantom line", () => {
    const previous = artifact("T0", [["a.md", "keep"]]);
    const current = artifact("T1", [
      ["a.md", "keep"],
      ["new.md", "one\ntwo\nthree"],
    ]);

    // An absent document contributes no lines, so the three added lines are the
    // only churn: a missing side must not inject a phantom empty line (which
    // would make this 4).
    expect(computeChurn(previous, current)).toBe(3);
  });
});

describe("computeRecovery", () => {
  test("excludes a transition with an indeterminate boundary judgment", () => {
    const history: CheckpointEvaluationRecord[] = [
      base("T0"),
      {
        checkpointId: "T1",
        factEvaluations: [fact("a", "indeterminate")],
        forgettingEvaluations: [],
        transitions: transitionsAt("T1", { introduced: [introduced("a")] }),
      },
      {
        checkpointId: "T2",
        factEvaluations: [fact("a", "correct")],
        forgettingEvaluations: [],
        transitions: transitionsAt("T2", {}),
      },
    ];

    expect(computeRecovery(history).rate).toBeUndefined();
  });

  test("an introduced fact wrong at its boundary that later reads correct recovers", () => {
    const history: CheckpointEvaluationRecord[] = [
      base("T0"),
      {
        checkpointId: "T1",
        factEvaluations: [fact("a", "missing")],
        forgettingEvaluations: [],
        transitions: transitionsAt("T1", { introduced: [introduced("a")] }),
      },
      {
        checkpointId: "T2",
        factEvaluations: [fact("a", "correct")],
        forgettingEvaluations: [],
        transitions: transitionsAt("T2", {}),
      },
    ];

    expect(computeRecovery(history).rate).toBe(1);
  });

  test("an introduced fact never made correct is eligible but not recovered", () => {
    const history: CheckpointEvaluationRecord[] = [
      base("T0"),
      {
        checkpointId: "T1",
        factEvaluations: [fact("a", "missing")],
        forgettingEvaluations: [],
        transitions: transitionsAt("T1", { introduced: [introduced("a")] }),
      },
      {
        checkpointId: "T2",
        factEvaluations: [fact("a", "contradicted")],
        forgettingEvaluations: [],
        transitions: transitionsAt("T2", {}),
      },
    ];

    expect(computeRecovery(history).rate).toBe(0);
  });

  test("a changed fact recovers only once the new version is correct and the old one is forgotten", () => {
    const history: CheckpointEvaluationRecord[] = [
      base("T0"),
      {
        checkpointId: "T1",
        factEvaluations: [fact("a", "correct")],
        forgettingEvaluations: [forget("a@T0", "lingering")],
        transitions: transitionsAt("T1", { changed: [changed("a", "a@T0")] }),
      },
      {
        checkpointId: "T2",
        factEvaluations: [fact("a", "correct")],
        forgettingEvaluations: [forget("a@T0", "forgotten")],
        transitions: transitionsAt("T2", {}),
      },
    ];

    // At T1 the new version is correct but the old one still lingers, so the
    // correction failed and is eligible. At T2 the old version is forgotten while
    // the new one stays correct, so it recovers.
    expect(computeRecovery(history).rate).toBe(1);
  });

  test("a changed fact does not recover while the obsolete version keeps lingering", () => {
    const history: CheckpointEvaluationRecord[] = [
      base("T0"),
      {
        checkpointId: "T1",
        factEvaluations: [fact("a", "correct")],
        forgettingEvaluations: [forget("a@T0", "lingering")],
        transitions: transitionsAt("T1", { changed: [changed("a", "a@T0")] }),
      },
      {
        checkpointId: "T2",
        factEvaluations: [fact("a", "correct")],
        forgettingEvaluations: [forget("a@T0", "lingering")],
        transitions: transitionsAt("T2", {}),
      },
    ];

    // The new version is correct throughout, but the obsolete version never gets
    // forgotten, so the correction never completes: eligible, not recovered.
    expect(computeRecovery(history).rate).toBe(0);
  });

  test("a changed fact needs the correction to hold at one checkpoint, not a stale forgetting carried forward", () => {
    const history: CheckpointEvaluationRecord[] = [
      base("T0"),
      {
        checkpointId: "T1",
        factEvaluations: [fact("a", "missing")],
        forgettingEvaluations: [forget("a@T0", "lingering")],
        transitions: transitionsAt("T1", { changed: [changed("a", "a@T0")] }),
      },
      {
        checkpointId: "T2",
        factEvaluations: [fact("a", "missing")],
        forgettingEvaluations: [forget("a@T0", "forgotten")],
        transitions: transitionsAt("T2", {}),
      },
      {
        checkpointId: "T3",
        factEvaluations: [fact("a", "correct")],
        forgettingEvaluations: [forget("a@T0", "lingering")],
        transitions: transitionsAt("T3", {}),
      },
    ];

    // The correction fails at its T1 boundary (new version missing). It never
    // recovers: at T2 the old version is forgotten but the new one is still
    // missing, and at T3 the new version is correct but the old one lingers again.
    // The correction must hold at the same later checkpoint, and none does.
    // Because forgetting is not permanent, the stale T2 forgetting is not carried
    // forward to T3.
    expect(computeRecovery(history).rate).toBe(0);
  });

  test("a removed fact recovers once its obsolete version is forgotten", () => {
    const history: CheckpointEvaluationRecord[] = [
      base("T0"),
      {
        checkpointId: "T1",
        factEvaluations: [],
        forgettingEvaluations: [forget("a@T0", "lingering")],
        transitions: transitionsAt("T1", { removed: [removed("a", "a@T0")] }),
      },
      {
        checkpointId: "T2",
        factEvaluations: [],
        forgettingEvaluations: [forget("a@T0", "forgotten")],
        transitions: transitionsAt("T2", {}),
      },
    ];

    // The removal is eligible because the obsolete version lingered at T1, and it
    // recovers once the version is forgotten at T2.
    expect(computeRecovery(history).rate).toBe(1);
  });

  test("a transition that succeeds at its own boundary is not eligible", () => {
    const history: CheckpointEvaluationRecord[] = [
      base("T0"),
      {
        checkpointId: "T1",
        factEvaluations: [fact("a", "correct")],
        forgettingEvaluations: [],
        transitions: transitionsAt("T1", { introduced: [introduced("a")] }),
      },
    ];

    // The introduced fact is correct at its own boundary, so it never failed and
    // is not counted.
    expect(computeRecovery(history).rate).toBeUndefined();
  });

  test("a stable fact that regresses is excluded from Recovery Rate in V1", () => {
    const history: CheckpointEvaluationRecord[] = [
      base("T0"),
      {
        checkpointId: "T1",
        factEvaluations: [fact("a", "missing")],
        forgettingEvaluations: [],
        transitions: transitionsAt("T1", { stable: [stable("a")] }),
      },
      {
        checkpointId: "T2",
        factEvaluations: [fact("a", "correct")],
        forgettingEvaluations: [],
        transitions: transitionsAt("T2", {}),
      },
    ];

    // "a" was stable, not introduced/changed/removed, so its regression at T1 is
    // never eligible for Recovery Rate. Nothing else was eligible -> undefined.
    expect(computeRecovery(history).rate).toBeUndefined();
  });

  test("is the fraction of eligible transitions that recover", () => {
    const history: CheckpointEvaluationRecord[] = [
      base("T0"),
      {
        checkpointId: "T1",
        factEvaluations: [fact("a", "missing"), fact("b", "missing")],
        forgettingEvaluations: [],
        transitions: transitionsAt("T1", {
          introduced: [introduced("a"), introduced("b")],
        }),
      },
      {
        checkpointId: "T2",
        factEvaluations: [fact("a", "correct"), fact("b", "missing")],
        forgettingEvaluations: [],
        transitions: transitionsAt("T2", {}),
      },
    ];

    // Both introductions failed at T1. "a" recovers at T2, "b" never does: 1 of
    // 2 eligible transitions recovered.
    expect(computeRecovery(history).rate).toBe(0.5);
  });
});

describe("computeStaleKnowledge", () => {
  test("does not resolve or extend lifetime for an indeterminate judgment", () => {
    const history: CheckpointEvaluationRecord[] = [
      {
        checkpointId: "T1",
        factEvaluations: [],
        forgettingEvaluations: [forget("a@T0", "indeterminate")],
      },
      {
        checkpointId: "T2",
        factEvaluations: [],
        forgettingEvaluations: [forget("a@T0", "forgotten")],
      },
    ];

    expect(computeStaleKnowledge(history)).toEqual({
      records: [
        { factVersionId: "a@T0", lingeredCheckpoints: 0, resolved: true },
      ],
      meanResolvedLifetime: 0,
      unresolvedCount: 0,
    });
  });

  test("records a version forgotten immediately as resolved with lifetime 0", () => {
    const history: CheckpointEvaluationRecord[] = [
      {
        checkpointId: "T1",
        factEvaluations: [],
        forgettingEvaluations: [forget("a@T0", "forgotten")],
      },
    ];

    expect(computeStaleKnowledge(history)).toEqual({
      records: [
        { factVersionId: "a@T0", lingeredCheckpoints: 0, resolved: true },
      ],
      meanResolvedLifetime: 0,
      unresolvedCount: 0,
    });
  });

  test("counts the checkpoints a version lingered before it was forgotten", () => {
    const history: CheckpointEvaluationRecord[] = [
      {
        checkpointId: "T1",
        factEvaluations: [],
        forgettingEvaluations: [forget("a@T0", "lingering")],
      },
      {
        checkpointId: "T2",
        factEvaluations: [],
        forgettingEvaluations: [forget("a@T0", "lingering")],
      },
      {
        checkpointId: "T3",
        factEvaluations: [],
        forgettingEvaluations: [forget("a@T0", "forgotten")],
      },
    ];

    // a@T0 lingered at T1 and T2 before being forgotten at T3 -> lifetime 2.
    expect(computeStaleKnowledge(history)).toEqual({
      records: [
        { factVersionId: "a@T0", lingeredCheckpoints: 2, resolved: true },
      ],
      meanResolvedLifetime: 2,
      unresolvedCount: 0,
    });
  });

  test("measures lifetime to the first forgetting and ignores a later recurrence", () => {
    const history: CheckpointEvaluationRecord[] = [
      {
        checkpointId: "T1",
        factEvaluations: [],
        forgettingEvaluations: [forget("a@T0", "lingering")],
      },
      {
        checkpointId: "T2",
        factEvaluations: [],
        forgettingEvaluations: [forget("a@T0", "forgotten")],
      },
      {
        checkpointId: "T3",
        factEvaluations: [],
        forgettingEvaluations: [forget("a@T0", "lingering")],
      },
    ];

    // a@T0 lingered once (T1) before being forgotten at T2. It lingers again at
    // T3 (a recurrence) but the stale lifetime is the time to the *first*
    // forgetting, so it stays 1 and the version stays resolved. The recurrence
    // remains in the raw forgetting history without inflating the lifetime.
    expect(computeStaleKnowledge(history)).toEqual({
      records: [
        { factVersionId: "a@T0", lingeredCheckpoints: 1, resolved: true },
      ],
      meanResolvedLifetime: 1,
      unresolvedCount: 0,
    });
  });

  test("preserves an unresolved version without folding it into the mean", () => {
    const history: CheckpointEvaluationRecord[] = [
      {
        checkpointId: "T1",
        factEvaluations: [],
        forgettingEvaluations: [
          forget("a@T0", "lingering"),
          forget("b@T0", "forgotten"),
        ],
      },
      {
        checkpointId: "T2",
        factEvaluations: [],
        forgettingEvaluations: [forget("a@T0", "lingering")],
      },
    ];

    // a@T0 lingered twice and was never forgotten: unresolved, kept as a record
    // but not averaged. b@T0 was forgotten immediately: resolved, lifetime 0. The
    // mean is over resolved versions only, so it is 0, not (2 + 0) / 2.
    expect(computeStaleKnowledge(history)).toEqual({
      records: [
        { factVersionId: "a@T0", lingeredCheckpoints: 2, resolved: false },
        { factVersionId: "b@T0", lingeredCheckpoints: 0, resolved: true },
      ],
      meanResolvedLifetime: 0,
      unresolvedCount: 1,
    });
  });

  test("is empty with no resolved mean when no version was ever obsolete", () => {
    const history: CheckpointEvaluationRecord[] = [
      {
        checkpointId: "T0",
        factEvaluations: [fact("a", "correct")],
        forgettingEvaluations: [],
      },
    ];

    expect(computeStaleKnowledge(history)).toEqual({
      records: [],
      meanResolvedLifetime: undefined,
      unresolvedCount: 0,
    });
  });
});

describe("computeDiagnostics", () => {
  test("bundles the transition-level recovery rate and the stale-knowledge records", () => {
    const history: CheckpointEvaluationRecord[] = [
      base("T0"),
      {
        checkpointId: "T1",
        factEvaluations: [fact("a", "missing")],
        forgettingEvaluations: [forget("b@T0", "lingering")],
        transitions: transitionsAt("T1", {
          introduced: [introduced("a")],
          removed: [removed("b", "b@T0")],
        }),
      },
      {
        checkpointId: "T2",
        factEvaluations: [fact("a", "correct")],
        forgettingEvaluations: [forget("b@T0", "forgotten")],
        transitions: transitionsAt("T2", {}),
      },
    ];

    // Recovery: the introduced "a" fails at T1 then reads correct at T2, and the
    // removed "b@T0" lingers at T1 then is forgotten at T2. Both eligible
    // transitions recover -> 1. Stale knowledge: b@T0 lingered once before being
    // forgotten -> one resolved record with lifetime 1.
    expect(computeDiagnostics(history)).toEqual({
      recovery: { rate: 1, recovered: 2, eligible: 2 },
      staleKnowledge: {
        records: [
          { factVersionId: "b@T0", lingeredCheckpoints: 1, resolved: true },
        ],
        meanResolvedLifetime: 1,
        unresolvedCount: 0,
      },
    });
  });
});
