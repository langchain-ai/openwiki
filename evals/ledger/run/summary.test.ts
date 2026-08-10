import { describe, expect, test } from "vitest";

import type { CheckpointScore, LedgerRunResult } from "../core/types.js";
import {
  formatRunSummary,
  selectWeakestPoint,
  selectWorstOffenders,
} from "./summary.js";

/**
 * Build a clean, fully-adjudicated checkpoint with no defects.
 *
 * @param checkpointId - Identifier for the checkpoint.
 *
 * @returns A checkpoint score scoring perfectly on every dimension.
 */
function cleanCheckpoint(checkpointId: string): CheckpointScore {
  return {
    checkpointId,
    coverage: {
      correct: 2,
      partial: 0,
      missing: 0,
      contradicted: 0,
      indeterminate: 0,
      total: 2,
      score: 1,
    },
    precision: {
      supported: 2,
      invented: 0,
      stale: 0,
      unverified: 0,
      adjudicated: 2,
      total: 2,
      hallucinationRate: 0,
      stalenessRate: 0,
      unverifiedRate: 0,
      score: 1,
    },
    evaluationCompleteness: { judged: 4, indeterminate: 0, total: 4, score: 1 },
    efficiency: { durationMs: 1000, skipped: false },
    evaluations: {
      factEvaluations: [
        {
          factId: "add",
          factVersionId: "add@T0",
          verdict: "correct",
          evidence: ["guide.md::0000"],
          rationale: "Documented.",
        },
      ],
      precisionEvaluations: [
        {
          assertion: "add returns 5",
          location: "guide.md",
          verdict: "supported",
          tense: "current",
          adjudicatedBy: "source",
          evidenceIds: ["src/add.ts"],
          rationale: "Matches source.",
        },
      ],
      forgettingEvaluations: [],
    },
  };
}

/**
 * Build a checkpoint riddled with one of every defect class the footer ranks.
 *
 * @param checkpointId - Identifier for the checkpoint.
 *
 * @returns A checkpoint score carrying invented, stale, contradicted, and
 *   missing verdicts plus an unverified claim.
 */
function defectiveCheckpoint(checkpointId: string): CheckpointScore {
  return {
    checkpointId,
    coverage: {
      correct: 0,
      partial: 0,
      missing: 1,
      contradicted: 1,
      indeterminate: 0,
      total: 2,
      score: 0.5,
    },
    precision: {
      supported: 1,
      invented: 1,
      stale: 1,
      unverified: 1,
      adjudicated: 3,
      total: 4,
      hallucinationRate: 1 / 3,
      stalenessRate: 1 / 3,
      unverifiedRate: 0.25,
      score: 0.5,
    },
    evaluationCompleteness: { judged: 6, indeterminate: 0, total: 6, score: 1 },
    efficiency: { durationMs: 1000, skipped: false },
    evaluations: {
      factEvaluations: [
        {
          factId: "divide",
          factVersionId: "divide@T1",
          verdict: "missing",
          evidence: [],
          rationale: "Not documented.",
        },
        {
          factId: "add",
          factVersionId: "add@T1",
          verdict: "contradicted",
          evidence: ["guide.md::0001"],
          rationale: "States the wrong result.",
        },
      ],
      precisionEvaluations: [
        {
          assertion: "the retry budget defaults to 5 attempts",
          location: "guide.md",
          verdict: "invented",
          tense: "current",
          adjudicatedBy: "source",
          evidenceIds: ["src/retry.ts"],
          rationale: "No such default exists.",
        },
        {
          assertion: "negate exists",
          location: "guide.md",
          verdict: "stale",
          tense: "current",
          adjudicatedBy: "ledger",
          evidenceIds: ["negate@T0"],
          rationale: "Removed before this checkpoint.",
        },
        {
          assertion: "maintainers prefer tabs",
          location: "guide.md",
          verdict: "unverified",
          tense: "current",
          adjudicatedBy: "none",
          evidenceIds: [],
          rationale: "Not refuted by bounded evidence.",
        },
      ],
      forgettingEvaluations: [],
    },
  };
}

/**
 * Assemble a two-checkpoint run result: one clean, one defective.
 *
 * @returns A complete run result usable as summary input.
 */
function result(): LedgerRunResult {
  return {
    metadata: {
      benchmarkName: "calc-evolution",
      startedAt: "2026-01-01T00:00:00.000Z",
      system: { provider: "anthropic", modelId: "system" },
      evaluatorModelId: "judge",
    },
    checkpoints: [cleanCheckpoint("T0"), defectiveCheckpoint("T1")],
    score: {
      traceCoverage: 0.75,
      tracePrecision: 0.75,
      traceHallucinationRate: 0.1,
      traceStalenessRate: 0.1,
      traceUnverifiedRate: 0.2,
      evaluationCompleteness: 0.95,
      quality: 0.7,
      maintenanceRates: { completeForgetting: 1 },
      maintenance: 0.9,
      ledgerScore: 0.8,
    },
    diagnostics: {
      recovery: { rate: 0.5, recovered: 1, eligible: 2 },
      staleKnowledge: {
        records: [],
        meanResolvedLifetime: 2.5,
        unresolvedCount: 1,
      },
    },
  };
}

describe("selectWorstOffenders", () => {
  test("ranks by severity: invented, then contradicted, then stale, then missing", () => {
    const offenders = selectWorstOffenders(result(), 10);

    expect(offenders.map((offender) => offender.className)).toEqual([
      "invented",
      "contradicted",
      "stale",
      "missing",
    ]);
  });

  test("respects the requested limit", () => {
    expect(selectWorstOffenders(result(), 2)).toHaveLength(2);
  });
});

describe("selectWeakestPoint", () => {
  test("returns the single lowest-scoring checkpoint dimension", () => {
    expect(selectWeakestPoint(result())).toEqual({
      checkpointId: "T1",
      dimension: "coverage",
      value: 0.5,
    });
  });
});

describe("formatRunSummary", () => {
  test("renders the headline, metrics, diagnostics, and worklist pointer", () => {
    const summary = formatRunSummary(result(), {
      unverifiedClaimsPath: "/runs/demo/unverified-claims.md",
      elapsedMs: 123_000,
    });

    expect(summary).toContain(
      "├ 📊 LEDGER 80.0% · quality 70.0% · maintenance 90.0%",
    );
    expect(summary).toContain("│  ├ coverage 75.0%");
    expect(summary).toContain("│  ├ precision 75.0%");
    expect(summary).toContain("│  ├ hallucination 10.0%");
    expect(summary).toContain("│  └ forgetting 100.0%");
    expect(summary).toContain(
      "stale-knowledge lifetime 2.5 checkpoints · 1 still stale at trace end",
    );
    expect(summary).toContain("recovery 1 of 2 regressions recovered later");
    expect(summary).toContain("weakest point T1 · coverage 50.0%");
    expect(summary).toContain(
      '│  ├ T1 · invented "the retry budget defaults to 5 attempts"',
    );
    expect(summary).toContain(
      "1 claim the source evidence neither confirmed nor refuted → /runs/demo/unverified-claims.md",
    );
    expect(summary).toContain("└ ⚠️ LEDGER 80.0% · 2m 3s");
  });

  test("omits the unverified-claims block when no worklist was written", () => {
    const summary = formatRunSummary(result());

    expect(summary).not.toContain("Unverified claims");
    expect(summary).not.toContain("unverified-claims.md");
  });

  test("drops maintenance from the headline for a single-checkpoint trace", () => {
    const single = result();
    single.score.maintenance = undefined;

    const summary = formatRunSummary(single);

    expect(summary).toContain("├ 📊 LEDGER 80.0% · quality 70.0%");
    expect(summary).not.toContain("maintenance");
  });

  test("marks a fully-adjudicated run as celebratory", () => {
    const complete = result();
    complete.score.evaluationCompleteness = 1;

    expect(formatRunSummary(complete)).toContain("└ 🎉 LEDGER 80.0%");
  });
});
