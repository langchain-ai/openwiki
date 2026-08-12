import { expect, test } from "vitest";
import type { LedgerRunResult } from "../core/types.js";
import { formatRunSummary } from "./summary.js";

const result: LedgerRunResult = {
  metadata: {
    benchmarkName: "taskflow",
    difficulty: "medium",
    startedAt: "2026-01-01T00:00:00.000Z",
    system: { provider: "fake" },
  },
  checkpoints: [],
  score: { value: 0.84, claimHealth: 0.84 },
  diagnostics: { staleKnowledge: { records: [], unresolvedCount: 0 } },
};

test("renders only the audit link and completion", () => {
  expect(
    formatRunSummary(result, {
      detailsPath: "/runs/report.md",
      elapsedMs: 123_000,
    }),
  ).toBe(
    "│\n├ 🔬 Details → /runs/report.md\n└ ✅ LEDGER score 84% · 2m 3s\n\n",
  );
});

test("shows successful completion when evaluator warnings were reported", () => {
  const withIndeterminateEvaluation: LedgerRunResult = {
    ...result,
    checkpoints: [
      {
        checkpointId: "T0",
        claims: {
          supported: 1,
          stale: 0,
          invented: 0,
          unverified: 0,
          total: 1,
          supportedRate: 1,
          stalenessRate: 0,
          hallucinationRate: 0,
          unverifiedRate: 0,
        },
        evaluationCompleteness: {
          judged: 222,
          indeterminate: 2,
          total: 224,
          rate: 222 / 224,
        },
        efficiency: { durationMs: 1, skipped: false },
      },
    ],
  };

  expect(formatRunSummary(withIndeterminateEvaluation)).toContain(
    "└ ✅ LEDGER score 84%",
  );
});
