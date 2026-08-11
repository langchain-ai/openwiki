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
