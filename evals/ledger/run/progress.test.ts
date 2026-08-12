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

  test("renders claim-state percentages and counts without forgetting output", () => {
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
      supportedCount: 82,
      staleCount: 10,
      hallucinatedCount: 2,
      unverifiedCount: 6,
      supportedRate: 0.82,
      stalenessRate: 0.1,
      hallucinationRate: 0.02,
      unverifiedRate: 0.06,
      forgottenCount: 4,
      obsoleteFactCount: 6,
      evaluationCompleteness: 1,
      indeterminateCount: 0,
      evaluationItemCount: 106,
      staleClaims: [
        { location: "wiki/a.md", assertion: "The old default is two." },
      ],
      hallucinatedClaims: [
        { location: "wiki/b.md", assertion: "A made-up module exists." },
      ],
    });
    expect(rendered).toContain("🔍 Extracting claims · 44%");
    expect(rendered).toContain("🔍 Grounding 100 claims · 49%");
    expect(rendered).toContain("📊 100 claims");
    expect(rendered).toContain(
      "supported 82% (82) · stale 10% (10) · hallucinated 2% (2) · unverified 6% (6)",
    );
    expect(rendered).not.toContain("obsolete");
    expect(rendered).not.toContain("The old default");
  });

  test("shows evaluator incompleteness", () => {
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
      supportedCount: 10,
      staleCount: 0,
      hallucinatedCount: 0,
      unverifiedCount: 0,
      supportedRate: 1,
      stalenessRate: 0,
      hallucinationRate: 0,
      unverifiedRate: 0,
      forgottenCount: 0,
      obsoleteFactCount: 0,
      evaluationCompleteness: 0.9,
      indeterminateCount: 1,
      evaluationItemCount: 10,
      staleClaims: [],
      hallucinatedClaims: [],
    });
    expect(rendered).not.toContain("obsolete facts");
    expect(rendered).toContain("evaluator 90% complete");
  });

  test("shows populated sub-percent metrics and all verbose claim details", () => {
    let rendered = "";
    const report = createCliProgressReporter(
      {
        write: (text) => {
          rendered += text;
        },
      },
      { verbose: true },
    );

    report({
      type: "checkpoint-complete",
      checkpointId: "T4",
      claimCount: 1_325,
      supportedCount: 1_239,
      staleCount: 24,
      hallucinatedCount: 6,
      unverifiedCount: 56,
      supportedRate: 1_239 / 1_325,
      stalenessRate: 24 / 1_325,
      hallucinationRate: 6 / 1_325,
      unverifiedRate: 56 / 1_325,
      forgottenCount: 12,
      obsoleteFactCount: 13,
      evaluationCompleteness: 1,
      indeterminateCount: 0,
      evaluationItemCount: 1_533,
      staleClaims: [
        { location: "architecture/a.md", assertion: "Old fact one." },
        {
          location: "architecture/b.md",
          assertion: "Old fact\n two.",
        },
      ],
      hallucinatedClaims: [
        { location: "quickstart.md", assertion: "Invented fact." },
      ],
    });

    expect(rendered).toContain("hallucinated <1% (6)");
    expect(rendered).toContain("│    ↳ stale");
    expect(rendered).toContain(
      "architecture/a.md · “Old fact one.”\n│       architecture/b.md · “Old fact two.”",
    );
    expect(rendered).toContain("│    ↳ hallucinated");
    expect(rendered).toContain("quickstart.md · “Invented fact.”");
    expect(rendered).not.toContain("forgot 12/13");
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
