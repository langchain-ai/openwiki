import { expect, test } from "vitest";
import type { LedgerRunResult } from "../core/types.js";
import { formatRunSummary } from "./summary.js";

function tokenCheckpoint(
  totalTokens?: number,
): LedgerRunResult["checkpoints"][number] {
  return {
    checkpointId: `T${totalTokens ?? "unknown"}`,
    claims: {
      supported: 0,
      stale: 0,
      invented: 0,
      unverified: 0,
      total: 0,
      supportedRate: 0,
      stalenessRate: 0,
      hallucinationRate: 0,
      unverifiedRate: 0,
    },
    evaluationCompleteness: {
      judged: 0,
      indeterminate: 0,
      total: 0,
      rate: 1,
    },
    efficiency: { durationMs: 1, skipped: false, totalTokens },
  };
}

const result: LedgerRunResult = {
  metadata: {
    benchmarkName: "taskflow",
    difficulty: "medium",
    startedAt: "2026-01-01T00:00:00.000Z",
    system: { provider: "fake" },
  },
  checkpoints: [],
  score: { value: 0.84, claimHealth: 0.89, forgetting: 0.79 },
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

test("sums complete OpenWiki token usage in the score footer", () => {
  expect(
    formatRunSummary({
      ...result,
      checkpoints: [
        tokenCheckpoint(182_000),
        tokenCheckpoint(74_000),
        tokenCheckpoint(160_000),
      ],
    }),
  ).toContain("LEDGER score 84% · 416k OpenWiki tokens");
});

test("does not present a partial token sum as the run total", () => {
  expect(
    formatRunSummary({
      ...result,
      checkpoints: [tokenCheckpoint(182_000), tokenCheckpoint()],
    }),
  ).not.toContain("OpenWiki tokens");
});
