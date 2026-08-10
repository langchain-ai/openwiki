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
          total: 2,
          score: 1,
        },
        precision: {
          supported: 2,
          contradicted: 0,
          unverifiable: 0,
          decidable: 2,
          total: 2,
          hallucinationRate: 0,
          unverifiableRate: 0,
          score: 1,
        },
        efficiency: { durationMs: 1000, skipped: false },
      },
    ],
    score: {
      traceCoverage: 1,
      tracePrecision: 1,
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
    expect(report).toContain(
      "| T0 | 100.0% | 100.0% | 0.0% | 0.0% | 1000 | - | no |",
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
                verdict: "unverifiable",
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
    expect(report).toContain("- Contradicted assertions (0 of 2):");
    expect(report).toContain("- Unverifiable assertions (1 of 2):");
    expect(report).toContain(
      '  - artifact/api/calc.md: "add uses IEEE-754 double-precision arithmetic" (source evidence does not establish representation)',
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
    expect(report).toContain("- Contradicted assertions (0 of 1):");
    expect(report).toContain("- Unverifiable assertions (0 of 1):");
    // A checkpoint with no obsolete versions renders no forgetting line at all.
    expect(report).not.toContain("- Forgetting (");
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
            total: 2,
            score: 0.5,
          },
          precision: {
            supported: 1,
            contradicted: 1,
            unverifiable: 0,
            decidable: 2,
            total: 2,
            hallucinationRate: 0.5,
            unverifiableRate: 0,
            score: 0.5,
          },
          efficiency: { durationMs: 0, skipped: true, churnedLines: 12 },
        },
      ],
    };
    const report = formatReport(withSkip);

    expect(report).toContain(
      "| T1 | 50.0% | 50.0% | 50.0% | 0.0% | 0 | 12 | yes |",
    );
  });
});
