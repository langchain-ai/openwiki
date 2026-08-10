import { describe, expect, test } from "vitest";

import { formatReport } from "./report.js";
import type { KebRunResult } from "../core/types.js";

/**
 * A minimal single-checkpoint run result with a perfect score and no maintenance
 * boundary, so the optional fields render as dashes by default.
 *
 * @returns A fresh result fixture each call, so mutating tests do not interfere.
 */
function result(): KebRunResult {
  return {
    metadata: {
      benchmarkName: "demo",
      startedAt: "2026-01-01T00:00:00.000Z",
      system: { provider: "anthropic", modelId: "claude-sonnet-5" },
      evaluatorModelId: "claude-sonnet-5",
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
          ledgerSupported: 2,
          sourceSupported: 0,
          unsupported: 0,
          contradicted: 0,
          notEstablished: 0,
          indeterminate: 0,
          judged: 2,
          total: 2,
          unsupportedRate: 0,
          extraKnowledgeRate: 0,
          score: 1,
        },
        evaluationCompleteness: {
          judged: 4,
          indeterminate: 0,
          total: 4,
          score: 1,
        },
        efficiency: { durationMs: 1000, skipped: false },
      },
    ],
    score: {
      traceCoverage: 1,
      tracePrecision: 1,
      evaluationCompleteness: 1,
      quality: 1,
      maintenanceRates: {},
      kebScore: 1,
    },
    diagnostics: { staleKnowledge: { records: [], unresolvedCount: 0 } },
  };
}

describe("formatReport", () => {
  test("renders the headline score and a checkpoint row", () => {
    const report = formatReport(result());

    expect(report).toContain("## KEB Score: 100.0%");
    expect(report).toContain("- Quality: 100.0%");
    expect(report).toContain("- Required claims (ledger-backed): 2 (100.0%)");
    expect(report).toContain("- Valid extras (source-backed): 0 (0.0%)");
    expect(report).toContain("- Hallucinated: 0 (0.0%)");
    expect(report).toContain(
      "| Unsupported | Hallucinated | Not established |",
    );
    expect(report).toContain(
      "| T0 | 100.0% | 100.0% | 2 | 0 | 0 (0.0%) | 0 | 0 | 100.0% | 1000 | - | no |",
    );
  });

  test("identifies evaluator-only replay provenance", () => {
    const replayed: KebRunResult = {
      ...result(),
      metadata: {
        ...result().metadata,
        reevaluatedFrom: "/saved/original-run",
      },
    };

    expect(formatReport(replayed)).toContain(
      "- Re-evaluated from: /saved/original-run",
    );
  });

  test("dashes an undefined maintenance score when no boundary occurred", () => {
    const report = formatReport(result());

    expect(report).toContain("- Maintenance: -");
    expect(report).toContain("- New-Knowledge Discovery: -");
  });

  test("dashes diagnostics that had no data to compute them from", () => {
    const report = formatReport(result());

    expect(report).toContain("- Recovery Rate: -");
    expect(report).toContain(
      "- Stale-Knowledge Lifetime (mean over resolved versions): -",
    );
    expect(report).toContain("  - Unresolved obsolete versions: 0");
  });

  test("renders populated diagnostics and surfaces unresolved versions", () => {
    const populated: KebRunResult = {
      ...result(),
      diagnostics: {
        recoveryRate: 0.5,
        staleKnowledge: {
          records: [
            { factVersionId: "a@T0", lingeredCheckpoints: 2, resolved: true },
            { factVersionId: "b@T0", lingeredCheckpoints: 3, resolved: false },
          ],
          meanResolvedLifetime: 2,
          unresolvedCount: 1,
        },
      },
    };
    const report = formatReport(populated);

    expect(report).toContain("- Recovery Rate: 50.0%");
    expect(report).toContain(
      "- Stale-Knowledge Lifetime (mean over resolved versions): 2.0 checkpoints",
    );
    expect(report).toContain("  - Unresolved obsolete versions: 1");
  });

  test("omits the evaluation detail section when no checkpoint carries verdicts", () => {
    const report = formatReport(result());

    expect(report).not.toContain("## Evaluation detail");
  });

  test("renders coverage gaps, precision diagnostics, and forgetting", () => {
    const detailed: KebRunResult = {
      ...result(),
      checkpoints: [
        {
          ...result().checkpoints[0],
          evaluations: {
            factEvaluations: [
              {
                factId: "add-behavior",
                factVersionId: "add-behavior@T0",
                verdict: "correct",
                evidence: ["api/calc.md"],
                rationale: "stated in the calc reference",
              },
              {
                factId: "subtract-behavior",
                factVersionId: "subtract-behavior@T0",
                verdict: "missing",
                evidence: [],
                rationale: "the wiki never mentions subtraction",
              },
            ],
            precisionEvaluations: [
              {
                assertion: "add returns the sum of its arguments",
                location: "artifact/api/calc.md",
                verdict: "supported",
                evidenceIds: ["src/calc.ts::0000"],
                rationale: "matches the add fact",
              },
              {
                assertion: "add uses IEEE-754 double-precision arithmetic",
                location: "artifact/api/calc.md",
                verdict: "unsupported",
                unsupportedReason: "not-established",
                verificationSource: "source",
                evidenceIds: [],
                rationale: "source evidence does not establish representation",
              },
            ],
            forgettingEvaluations: [
              {
                factId: "auth-scheme",
                factVersionId: "auth-scheme@T0",
                verdict: "lingering",
                evidence: ["architecture/overview.md"],
                rationale: "the old API-key scheme is still documented",
              },
            ],
          },
        },
      ],
    };
    const report = formatReport(detailed);

    expect(report).toContain("## Evaluation detail");
    expect(report).toContain("### T0");
    expect(report).toContain("- Coverage gaps (1):");
    expect(report).toContain(
      "  - `subtract-behavior` missing: the wiki never mentions subtraction",
    );
    expect(report).toContain("- Unsupported assertions (1 of 2):");
    expect(report).toContain(
      '  - not-established · artifact/api/calc.md: "add uses IEEE-754 double-precision arithmetic" (source evidence does not establish representation)',
    );
    expect(report).toContain("- Forgetting (1):");
    expect(report).toContain(
      "  - `auth-scheme@T0` lingering: the old API-key scheme is still documented",
    );
  });

  test("reports a clean checkpoint as having no gaps rather than omitting it", () => {
    const clean: KebRunResult = {
      ...result(),
      checkpoints: [
        {
          ...result().checkpoints[0],
          evaluations: {
            factEvaluations: [
              {
                factId: "add-behavior",
                factVersionId: "add-behavior@T0",
                verdict: "correct",
                evidence: ["api/calc.md"],
                rationale: "stated in the calc reference",
              },
            ],
            precisionEvaluations: [
              {
                assertion: "add returns the sum of its arguments",
                location: "artifact/api/calc.md",
                verdict: "supported",
                evidenceIds: ["src/calc.ts::0000"],
                rationale: "matches the add fact",
              },
            ],
            forgettingEvaluations: [],
          },
        },
      ],
    };
    const report = formatReport(clean);

    expect(report).toContain(
      "  - none; every material topic is stated correctly",
    );
    expect(report).toContain("- Unsupported assertions (0 of 1):");
    // A checkpoint with no obsolete versions renders no forgetting line at all.
    expect(report).not.toContain("- Forgetting (");
  });

  test("reports evaluator incompleteness and its item-level warning", () => {
    const degraded = result();
    degraded.score.evaluationCompleteness = 0.75;
    degraded.checkpoints[0].evaluationCompleteness = {
      judged: 3,
      indeterminate: 1,
      total: 4,
      score: 0.75,
    };
    degraded.checkpoints[0].evaluations = {
      factEvaluations: [
        {
          factId: "version",
          factVersionId: "version@T0",
          verdict: "indeterminate",
          evidence: [],
          rationale: "isolated repair failed",
        },
      ],
      precisionEvaluations: [],
      forgettingEvaluations: [],
      warnings: [
        {
          pass: "coverage",
          itemId: "version",
          message: "invented citation; isolated repair failed",
        },
      ],
    };

    const report = formatReport(degraded);

    expect(report).toContain("- Evaluator Completeness: 75.0%");
    expect(report).toContain(
      "| T0 | 100.0% | 100.0% | 2 | 0 | 0 (0.0%) | 0 | 0 | 75.0%",
    );
    expect(report).toContain(
      "- coverage `version`: invented citation; isolated repair failed",
    );
  });

  test("marks a skipped checkpoint and renders its churn", () => {
    const withSkip: KebRunResult = {
      ...result(),
      checkpoints: [
        result().checkpoints[0],
        {
          checkpointId: "T1",
          coverage: {
            correct: 1,
            partial: 1,
            missing: 0,
            contradicted: 0,
            indeterminate: 0,
            total: 2,
            score: 0.5,
          },
          precision: {
            supported: 1,
            ledgerSupported: 0,
            sourceSupported: 1,
            unsupported: 1,
            contradicted: 1,
            notEstablished: 0,
            indeterminate: 0,
            judged: 2,
            total: 2,
            unsupportedRate: 0.5,
            extraKnowledgeRate: 0.5,
            score: 0.5,
          },
          evaluationCompleteness: {
            judged: 4,
            indeterminate: 0,
            total: 4,
            score: 1,
          },
          efficiency: { durationMs: 0, skipped: true, churnedLines: 12 },
        },
      ],
    };
    const report = formatReport(withSkip);

    expect(report).toContain(
      "| T1 | 50.0% | 50.0% | 0 | 1 | 1 (50.0%) | 1 | 0 | 100.0% | 0 | 12 | yes |",
    );
  });
});
