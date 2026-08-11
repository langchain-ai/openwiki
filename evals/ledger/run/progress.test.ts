import { describe, expect, test } from "vitest";
import {
  createCliProgressReporter,
  formatProgressDuration,
} from "./progress.js";

test("formats compact durations", () => {
  expect(formatProgressDuration(850)).toBe("850ms");
  expect(formatProgressDuration(4_200)).toBe("4.2s");
  expect(formatProgressDuration(123_000)).toBe("2m 3s");
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
      type: "checkpoint-complete",
      checkpointId: "T1",
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
      "📊 claims · 82% supported · 10% stale · 2% hallucinated · 6% unverified",
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
