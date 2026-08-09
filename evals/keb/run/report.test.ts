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
      evaluatorPromptVersion: "keb-eval-1",
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
        precision: { supported: 2, unsupported: 0, total: 2, score: 1 },
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
    expect(report).toContain("| T0 | 100.0% | 100.0% | 1000 | - | no |");
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
          precision: { supported: 1, unsupported: 1, total: 2, score: 0.5 },
          efficiency: { durationMs: 0, skipped: true, churnedLines: 12 },
        },
      ],
    };
    const report = formatReport(withSkip);

    expect(report).toContain("| T1 | 50.0% | 50.0% | 0 | 12 | yes |");
  });
});
