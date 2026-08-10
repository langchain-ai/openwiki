import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createCliProgressReporter,
  formatProgressDuration,
} from "./progress.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("formatProgressDuration", () => {
  test("uses compact units appropriate to the elapsed time", () => {
    expect(formatProgressDuration(850)).toBe("850ms");
    expect(formatProgressDuration(4_200)).toBe("4.2s");
    expect(formatProgressDuration(123_000)).toBe("2m 3s");
  });
});

describe("createCliProgressReporter", () => {
  test("renders a framed benchmark lifecycle with checkpoint detail", () => {
    let rendered = "";
    const report = createCliProgressReporter({
      write: (text) => {
        rendered += text;
      },
    });

    report({
      type: "run-start",
      benchmarkName: "calc-evolution",
      difficulty: "hard",
      totalCheckpoints: 3,
      provider: "anthropic",
      systemModelId: "system-model",
      evaluatorModelId: "evaluator-model",
    });
    report({ type: "replay-ready" });
    report({
      type: "checkpoint-start",
      checkpointId: "T1",
      checkpointIndex: 1,
      totalCheckpoints: 3,
      commit: "abcdef0123456789",
      label: "change calculation",
      command: "update",
    });
    report({
      type: "system-complete",
      checkpointId: "T1",
      command: "update",
      durationMs: 4_200,
      skipped: false,
    });
    report({
      type: "artifact-captured",
      checkpointId: "T1",
      documentCount: 4,
    });
    report({
      type: "evaluation-start",
      checkpointId: "T1",
      surfaceItemCount: 7,
      obsoleteFactCount: 2,
    });
    report({
      type: "checkpoint-complete",
      checkpointId: "T1",
      coverageScore: 0.86,
      precisionScore: 0.75,
      hallucinationRate: 0.125,
      forgottenCount: 1,
      obsoleteFactCount: 2,
      evaluationCompleteness: 0.9,
      indeterminateCount: 1,
      evaluationItemCount: 10,
    });
    report({
      type: "checkpoint-complete",
      checkpointId: "T0",
      coverageScore: 1,
      precisionScore: 1,
      hallucinationRate: 0,
      forgottenCount: 0,
      obsoleteFactCount: 0,
      evaluationCompleteness: 1,
      indeterminateCount: 0,
      evaluationItemCount: 10,
    });
    report({ type: "run-complete" });

    expect(rendered).toContain("┌ 🧪 LEDGER · calc-evolution · hard");
    expect(rendered).toContain(
      "3 checkpoints · anthropic · system system-model · evaluator evaluator-model",
    );
    expect(rendered).toContain("├ 📍 2/3 · T1 · abcdef0 · change calculation");
    expect(rendered).toContain("Running OpenWiki update");
    expect(rendered).toContain("OpenWiki update complete · 4.2s");
    expect(rendered).toContain("Captured 4 documents");
    expect(rendered).toContain(
      "Evaluating 7 surface items · 2 obsolete versions",
    );
    expect(rendered).toContain(
      "✅ T1 · coverage 86% · precision 75% · hallucination 13% · forgetting 50% (1/2)",
    );
    expect(rendered).toContain(
      "✅ T0 · coverage 100% · precision 100% · hallucination 0% · forgetting -",
    );
    expect(rendered).toContain(
      "↳ ⚠️ evaluator 90% complete · 1/10 indeterminate",
    );
  });

  test("hides the indeterminate note when every judgment completed", () => {
    let rendered = "";
    const report = createCliProgressReporter({
      write: (text) => {
        rendered += text;
      },
    });

    report({
      type: "checkpoint-complete",
      checkpointId: "T0",
      coverageScore: 1,
      precisionScore: 1,
      hallucinationRate: 0,
      forgottenCount: 0,
      obsoleteFactCount: 0,
      evaluationCompleteness: 1,
      indeterminateCount: 0,
      evaluationItemCount: 10,
    });

    expect(rendered).not.toContain("indeterminate");
  });

  test("emits no footer output on run completion", () => {
    let rendered = "";
    const report = createCliProgressReporter({
      write: (text) => {
        rendered += text;
      },
    });

    report({ type: "run-complete" });

    expect(rendered).toBe("");
  });

  test("closes the frame with one bounded failure line", () => {
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

  test("labels evaluator-only replay without claiming OpenWiki ran", () => {
    let rendered = "";
    const report = createCliProgressReporter({
      write: (text) => {
        rendered += text;
      },
    });

    report({
      type: "run-start",
      benchmarkName: "calc-evolution",
      difficulty: "hard",
      totalCheckpoints: 3,
      provider: "anthropic",
      evaluatorModelId: "evaluator-model",
      evaluationOnly: true,
    });
    report({ type: "replay-ready", saved: true });
    report({
      type: "checkpoint-start",
      checkpointId: "T0",
      checkpointIndex: 0,
      totalCheckpoints: 3,
      commit: "abcdef0123456789",
      command: "init",
      evaluationOnly: true,
    });
    report({
      type: "artifact-captured",
      checkpointId: "T0",
      documentCount: 4,
      loaded: true,
    });

    expect(rendered).toContain("saved artifacts · evaluator evaluator-model");
    expect(rendered).toContain("♻️ Saved artifacts and source evidence ready");
    expect(rendered).toContain("📚 Loaded 4 documents");
    expect(rendered).not.toContain("Running OpenWiki");
  });

  test("animates long-running activities in place on a TTY", () => {
    vi.useFakeTimers();
    let rendered = "";
    const report = createCliProgressReporter({
      isTTY: true,
      write: (text) => {
        rendered += text;
      },
    });

    report({
      type: "checkpoint-start",
      checkpointId: "T0",
      checkpointIndex: 0,
      totalCheckpoints: 1,
      commit: "abcdef0123456789",
      command: "init",
    });
    vi.advanceTimersByTime(160);

    expect(rendered).toContain("\r\u001B[2K│ ⠋ 🤖 Running OpenWiki init");
    expect(rendered).toContain("\r\u001B[2K│ ⠙ 🤖 Running OpenWiki init");

    report({
      type: "system-complete",
      checkpointId: "T0",
      command: "init",
      durationMs: 2_000,
      skipped: false,
    });

    expect(rendered).toContain(
      "\r\u001B[2K│ 🤖 OpenWiki init complete · 2.0s\n",
    );
    const completedOutput = rendered;
    vi.advanceTimersByTime(160);
    expect(rendered).toBe(completedOutput);
  });
});
