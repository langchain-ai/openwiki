import { describe, expect, test } from "vitest";
import type {
  CheckpointEvaluationRecord,
  PrecisionAssertionEvaluation,
} from "../core/types.js";
import {
  computeClaimState,
  computeEvaluationCompleteness,
  computeStaleKnowledge,
} from "./claims.js";

function claim(
  verdict: PrecisionAssertionEvaluation["verdict"],
  tense: PrecisionAssertionEvaluation["tense"] = "current",
): PrecisionAssertionEvaluation {
  return {
    assertion: verdict,
    location: "wiki.md",
    verdict,
    tense,
    adjudicatedBy: verdict === "unverified" ? "none" : "source",
    evidenceIds: verdict === "unverified" ? [] : ["source"],
    rationale: verdict,
  };
}

describe("computeClaimState", () => {
  test("uses one denominator for all current claim states", () => {
    expect(
      computeClaimState([
        claim("supported"),
        claim("supported"),
        claim("stale"),
        claim("invented"),
        claim("unverified"),
        claim("supported", "historical"),
      ]),
    ).toEqual({
      supported: 2,
      invented: 1,
      stale: 1,
      unverified: 1,
      total: 5,
      supportedRate: 0.4,
      hallucinationRate: 0.2,
      stalenessRate: 0.2,
      unverifiedRate: 0.2,
    });
  });

  test("returns zero rates when the wiki has no current claims", () => {
    expect(computeClaimState([claim("supported", "historical")]).total).toBe(0);
    expect(computeClaimState([]).supportedRate).toBe(0);
  });
});

test("evaluation completeness counts indeterminate forgetting judgments", () => {
  expect(
    computeEvaluationCompleteness(
      [claim("supported")],
      [
        {
          factId: "x",
          factVersionId: "x@1",
          verdict: "indeterminate",
          evidence: [],
          rationale: "failed",
        },
      ],
    ),
  ).toEqual({ judged: 1, indeterminate: 1, total: 2, rate: 0.5 });
});

test("evaluation completeness does not double-count warned fallback results", () => {
  expect(
    computeEvaluationCompleteness(
      [claim("unverified")],
      [
        {
          factId: "x",
          factVersionId: "x@1",
          verdict: "indeterminate",
          evidence: [],
          rationale: "failed",
        },
      ],
      [
        { pass: "precision-judgment", itemId: "claim-1", message: "failed" },
        { pass: "forgetting", itemId: "x@1", message: "failed" },
      ],
    ),
  ).toEqual({ judged: 0, indeterminate: 2, total: 2, rate: 0 });
});

test("evaluation completeness includes failed extraction units", () => {
  expect(
    computeEvaluationCompleteness(
      [],
      [],
      [{ pass: "precision-extraction", itemId: "unit-1", message: "failed" }],
    ),
  ).toEqual({ judged: 0, indeterminate: 1, total: 1, rate: 0 });
});

test("stale lifetime stops when an obsolete fact is first forgotten", () => {
  const history: CheckpointEvaluationRecord[] = [
    { forgettingEvaluations: [] },
    {
      forgettingEvaluations: [
        {
          factId: "x",
          factVersionId: "x@1",
          verdict: "lingering",
          evidence: [],
          rationale: "still current",
        },
      ],
    },
    {
      forgettingEvaluations: [
        {
          factId: "x",
          factVersionId: "x@1",
          verdict: "forgotten",
          evidence: [],
          rationale: "gone",
        },
      ],
    },
  ];
  expect(computeStaleKnowledge(history)).toEqual({
    records: [{ factVersionId: "x@1", lingeredCheckpoints: 1, resolved: true }],
    meanResolvedLifetime: 1,
    unresolvedCount: 0,
  });
});
