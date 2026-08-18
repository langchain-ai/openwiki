import { describe, expect, test } from "vitest";

import type { CheckpointResult } from "../core/types.js";
import { computeLedgerScore } from "./score.js";

function checkpoint(
  supported: number,
  total: number,
  forgetting: Array<"forgotten" | "lingering" | "indeterminate"> = [],
): CheckpointResult {
  return {
    checkpointId: "T0",
    claims: {
      supported,
      stale: total - supported,
      invented: 0,
      unverified: 0,
      total,
      supportedRate: total === 0 ? 0 : supported / total,
      stalenessRate: total === 0 ? 0 : (total - supported) / total,
      hallucinationRate: 0,
      unverifiedRate: 0,
    },
    evaluationCompleteness: {
      judged: total,
      indeterminate: 0,
      total,
      rate: 1,
    },
    efficiency: { durationMs: 1, skipped: false },
    evaluations: {
      precisionEvaluations: [],
      forgettingEvaluations: forgetting.map((verdict, index) => ({
        factId: `fact-${index}`,
        factVersionId: `fact-${index}@T0`,
        verdict,
        evidence: [],
        rationale: verdict,
      })),
    },
  };
}

describe("computeLedgerScore", () => {
  test("uses opportunity-weighted claim health", () => {
    const score = computeLedgerScore([
      checkpoint(8, 10, ["forgotten", "lingering"]),
      checkpoint(18, 20, ["forgotten", "forgotten"]),
    ]);

    expect(score).toEqual({ value: 26 / 30, claimHealth: 26 / 30 });
  });

  test("does not let obsolete-fact diagnostics affect the score", () => {
    expect(computeLedgerScore([checkpoint(8, 10, ["indeterminate"])])).toEqual({
      value: 0.8,
      claimHealth: 0.8,
    });
    expect(computeLedgerScore([checkpoint(10, 10, ["lingering"])])).toEqual({
      value: 1,
      claimHealth: 1,
    });
  });
});
