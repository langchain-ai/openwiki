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
      activeFactCount: 7,
      obsoleteFactCount: 2,
    });
    report({
      type: "checkpoint-complete",
      checkpointId: "T1",
      coverageScore: 0.86,
      precisionScore: 0.75,
      forgottenCount: 1,
      obsoleteFactCount: 2,
    });
    report({
      type: "checkpoint-complete",
      checkpointId: "T0",
      coverageScore: 1,
      precisionScore: 1,
      forgottenCount: 0,
      obsoleteFactCount: 0,
    });
    report({
      type: "run-complete",
      kebScore: 0.8,
      quality: 0.7,
      traceCoverage: 0.8,
      tracePrecision: 0.625,
      maintenance: 0.9,
      newKnowledgeDiscovery: 0.75,
      changedKnowledgeCorrection: 1,
      completeForgetting: 1,
      stableRetention: 0.85,
    });

    expect(rendered).toContain("┌ 🧪 KEB · calc-evolution");
    expect(rendered).toContain(
      "3 checkpoints · anthropic · system system-model · evaluator evaluator-model",
    );
    expect(rendered).toContain("├ 📍 2/3 · T1 · abcdef0 · change calculation");
    expect(rendered).toContain("Running OpenWiki update");
    expect(rendered).toContain("OpenWiki update complete · 4.2s");
    expect(rendered).toContain("Captured 4 documents");
    expect(rendered).toContain(
      "Evaluating 7 active facts · 2 obsolete versions",
    );
    expect(rendered).toContain(
      "✅ T1 · coverage 86% · precision 75% · forgetting 50% (1/2)",
    );
    expect(rendered).toContain(
      "✅ T0 · coverage 100% · precision 100% · forgetting -",
    );
    expect(rendered).toContain("├ 📊 Quality 70.0%");
    expect(rendered).toContain("│  ├ Coverage 80.0%");
    expect(rendered).toContain("│  └ Precision 62.5%");
    expect(rendered).toContain("├ 🔄 Maintenance 90.0%");
    expect(rendered).toContain("│  ├ Discovery 75.0%");
    expect(rendered).toContain("│  ├ Correction 100.0%");
    expect(rendered).toContain("│  ├ Forgetting 100.0%");
    expect(rendered).toContain("│  └ Retention 85.0%");
    expect(rendered).toMatch(/└ 🎉 KEB 80\.0% · \d+ms/u);
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
