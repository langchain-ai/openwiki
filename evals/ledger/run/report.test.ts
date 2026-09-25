import { expect, test } from "vitest";
import type { LedgerRunResult } from "../core/types.js";
import { formatReport } from "./report.js";

test("reports current claim state, forgetting, and the auditable score", () => {
  const result: LedgerRunResult = {
    metadata: {
      benchmarkName: "taskflow",
      difficulty: "medium",
      startedAt: "2026-01-01T00:00:00.000Z",
      system: { provider: "anthropic", modelId: "system" },
      evaluatorModelId: "judge",
    },
    checkpoints: [
      {
        checkpointId: "T1",
        claims: {
          supported: 82,
          stale: 10,
          invented: 2,
          unverified: 6,
          total: 100,
          supportedRate: 0.82,
          stalenessRate: 0.1,
          hallucinationRate: 0.02,
          unverifiedRate: 0.06,
        },
        evaluationCompleteness: {
          judged: 106,
          indeterminate: 0,
          total: 106,
          rate: 1,
        },
        efficiency: { durationMs: 4200, churnedLines: 12, skipped: false },
        evaluations: {
          precisionEvaluations: [],
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
      },
    ],
    score: {
      value: 0.82,
      claimHealth: 0.82,
    },
    diagnostics: {
      staleKnowledge: {
        records: [
          { factVersionId: "x@1", lingeredCheckpoints: 1, resolved: true },
        ],
        meanResolvedLifetime: 1,
        unresolvedCount: 0,
      },
    },
  };
  const report = formatReport(result);
  expect(report).toContain(
    "| T1 | 100 | 82.0% | 10.0% (10) | 2.0% (2) | 6.0% (6)",
  );
  expect(report).toContain("API forgetting");
  expect(report).toContain("LEDGER score: 82.0%");
  expect(report).toContain("Claim health: 82.0%");
  expect(report).not.toContain("Forgetting score");
  expect(report).not.toContain("Coverage");
});
