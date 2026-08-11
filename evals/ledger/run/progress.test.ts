import { describe, expect, test } from "vitest";
import {
  createCliProgressReporter,
  formatProgressDuration,
  formatProgressPercentage,
} from "./progress.js";

test("formats compact durations", () => {
  expect(formatProgressDuration(850)).toBe("850ms");
  expect(formatProgressDuration(4_200)).toBe("4.2s");
  expect(formatProgressDuration(123_000)).toBe("2m 3s");
});

test("formats bounded progress percentages", () => {
  expect(formatProgressPercentage(28, 64)).toBe("44%");
  expect(formatProgressPercentage(0, 0)).toBe("100%");
  expect(formatProgressPercentage(12, 10)).toBe("100%");
});

describe("createCliProgressReporter", () => {
  test("combines the completed OpenWiki run and artifact size", () => {
    let rendered = "";
    const report = createCliProgressReporter({
      write: (text) => {
        rendered += text;
      },
    });
    report({
      type: "checkpoint-start",
      checkpointId: "T1",
      checkpointIndex: 1,
      totalCheckpoints: 3,
      commit: "abcdef0123456789",
      command: "update",
    });
    report({
      type: "system-complete",
      checkpointId: "T1",
      command: "update",
      durationMs: 4_200,
      skipped: false,
    });
    report({ type: "artifact-captured", checkpointId: "T1", documentCount: 4 });
    expect(rendered).toContain("OpenWiki update complete · 4.2s · 4 documents");
    expect(rendered).not.toContain("Captured");
  });

  test("renders claim state and forgetting with a shared claim denominator", () => {
    let rendered = "";
    const report = createCliProgressReporter({
      write: (text) => {
        rendered += text;
      },
    });
    report({
      type: "evaluation-start",
      checkpointId: "T1",
      obsoleteFactCount: 6,
    });
    report({
      type: "claim-extraction-progress",
      checkpointId: "T1",
      completed: 28,
      total: 64,
      obsoleteFactCount: 6,
    });
    report({
      type: "claim-evaluation-progress",
      checkpointId: "T1",
      claimCount: 100,
      completed: 52,
      total: 106,
      obsoleteFactCount: 6,
    });
    report({
      type: "checkpoint-complete",
      checkpointId: "T1",
      claimCount: 100,
      supportedRate: 0.82,
      stalenessRate: 0.1,
      hallucinationRate: 0.02,
      unverifiedRate: 0.06,
      forgottenCount: 4,
      obsoleteFactCount: 6,
      evaluationCompleteness: 1,
      indeterminateCount: 0,
      evaluationItemCount: 106,
    });
    expect(rendered).toContain(
      "🔍 Extracting claims · 44% · 6 obsolete API facts",
    );
    expect(rendered).toContain(
      "🔍 Grounding 100 claims · 49% · 6 obsolete API facts",
    );
    expect(rendered).toContain(
      "📊 100 claims · 82% supported · 10% stale · 2% hallucinated · 6% unverified",
    );
    expect(rendered).toContain("🧹 forgot 4/6 obsolete facts · carrying 2");
  });

  test("shows evaluator incompleteness and omits an empty forgetting line", () => {
    let rendered = "";
    const report = createCliProgressReporter({
      write: (text) => {
        rendered += text;
      },
    });
    report({
      type: "checkpoint-complete",
      checkpointId: "T0",
      claimCount: 10,
      supportedRate: 1,
      stalenessRate: 0,
      hallucinationRate: 0,
      unverifiedRate: 0,
      forgottenCount: 0,
      obsoleteFactCount: 0,
      evaluationCompleteness: 0.9,
      indeterminateCount: 1,
      evaluationItemCount: 10,
    });
    expect(rendered).not.toContain("obsolete facts");
    expect(rendered).toContain("evaluator 90% complete");
  });

  test("closes failures with one bounded line", () => {
    let rendered = "";
    const report = createCliProgressReporter({
      write: (text) => {
        rendered += text;
      },
    });
    report({
      type: "run-failed",
      message: "Evaluator\nfailed   after timeout",
    });
    expect(rendered).toBe(
      "│\n└ ❌ Failed · Evaluator failed after timeout\n\n",
    );
  });
});
