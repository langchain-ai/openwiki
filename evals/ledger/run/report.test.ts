import { describe, expect, test } from "vitest";

import type { LedgerRunResult } from "../core/types.js";
import { formatReport } from "./report.js";

function result(): LedgerRunResult {
  return {
    metadata: {
      benchmarkName: "demo",
      startedAt: "2026-01-01T00:00:00.000Z",
      system: { provider: "anthropic", modelId: "system" },
      evaluatorModelId: "judge",
    },
    checkpoints: [
      {
        checkpointId: "T0",
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
          invented: 1,
          stale: 1,
          unverified: 1,
          adjudicated: 4,
          total: 5,
          hallucinationRate: 0.25,
          stalenessRate: 0.25,
          unverifiedRate: 0.2,
          score: 0.5,
        },
        evaluationCompleteness: {
          judged: 7,
          indeterminate: 0,
          total: 7,
          score: 1,
        },
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
              assertion: "add returns 6",
              location: "guide.md",
              verdict: "invented",
              tense: "current",
              adjudicatedBy: "source",
              evidenceIds: ["src/add.ts"],
              rationale: "Source returns 5.",
            },
            {
              assertion: "negate exists",
              location: "guide.md",
              verdict: "stale",
              tense: "current",
              adjudicatedBy: "ledger",
              evidenceIds: ["negate@T0", "negate@T1"],
              rationale: "It existed before removal.",
            },
            {
              assertion: "Maintainers prefer tabs",
              location: "guide.md",
              verdict: "unverified",
              tense: "current",
              adjudicatedBy: "none",
              evidenceIds: [],
              rationale: "Not refuted by bounded evidence.",
            },
          ],
          forgettingEvaluations: [
            {
              factId: "negate",
              factVersionId: "negate@T0",
              verdict: "forgotten",
              evidence: [],
              rationale: "No current presentation remains.",
            },
          ],
        },
      },
    ],
    score: {
      traceCoverage: 1,
      tracePrecision: 0.5,
      traceHallucinationRate: 0.25,
      traceStalenessRate: 0.25,
      traceUnverifiedRate: 0.2,
      evaluationCompleteness: 1,
      quality: 2 / 3,
      maintenanceRates: {},
      ledgerScore: 2 / 3,
    },
    diagnostics: {
      recovery: { recovered: 0, eligible: 0 },
      staleKnowledge: { records: [], unresolvedCount: 0 },
    },
  };
}

describe("formatReport", () => {
  test("renders four-class metrics and the assertion/fact staleness cross-check", () => {
    const report = formatReport(result());

    expect(report).toContain("## LEDGER Score: 66.7%");
    expect(report).toContain("- Trace Precision: 50.0%");
    expect(report).toContain("- Hallucination Rate: 25.0%");
    expect(report).toContain("- Staleness Rate: 25.0%");
    expect(report).toContain("- Unverified Rate: 20.0%");
    expect(report).toContain(
      "| Claim staleness | Unverified | Fact forgetting |",
    );
    expect(report).toContain(
      "| T0 | 100.0% | 50.0% | 25.0% | 25.0% | 20.0% | 100.0% (1/1)",
    );
  });

  test("renders claim-level classes and provenance", () => {
    const report = formatReport(result());

    expect(report).toContain("- Invented claims (1 of 3):");
    expect(report).toContain(
      'current · source · guide.md: "add returns 6" (Source returns 5.)',
    );
    expect(report).toContain("- Stale claims (1 of 3):");
    expect(report).toContain("- Unverified claims (1 of 3):");
    expect(report).toContain("- Fact forgetting (1):");
  });

  test("warns instead of throwing when no claims are adjudicated", () => {
    const empty = result();
    empty.checkpoints[0].precision = {
      supported: 0,
      invented: 0,
      stale: 0,
      unverified: 1,
      adjudicated: 0,
      total: 1,
      hallucinationRate: null,
      stalenessRate: null,
      unverifiedRate: 1,
      score: null,
    };
    empty.score.tracePrecision = null;
    empty.score.traceHallucinationRate = null;
    empty.score.traceStalenessRate = null;
    empty.score.traceUnverifiedRate = 1;
    empty.score.quality = null;
    empty.score.ledgerScore = null;

    const report = formatReport(empty);
    expect(report).toContain("## LEDGER Score: -");
    expect(report).toContain(
      "no checkpoint contained an adjudicated precision claim",
    );
  });

  test("identifies evaluator-only replay provenance", () => {
    const replayed = result();
    replayed.metadata.reevaluatedFrom = "/saved/original";
    expect(formatReport(replayed)).toContain(
      "- Re-evaluated from: /saved/original",
    );
  });
});
