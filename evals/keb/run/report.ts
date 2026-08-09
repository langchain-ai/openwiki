import type { KebRunResult } from "../core/types.js";

/**
 * Render a 0-to-1 fraction as a fixed-precision percentage string.
 *
 * @param value - A fraction in [0, 1].
 *
 * @returns The value as a percentage with one decimal place.
 */
function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Render `undefined` as a dash and a number verbatim, for optional cells.
 *
 * @param value - The value or undefined.
 *
 * @returns The value as a string, or "-" when absent.
 */
function cell(value: number | undefined): string {
  return value === undefined ? "-" : String(value);
}

/**
 * Render a maintenance rate as a percentage, or a dash when it is `undefined`
 * (its denominator was zero across the whole trace, so it did not apply).
 *
 * @param value - The rate in [0, 1], or undefined when it did not apply.
 *
 * @returns The rate as a percentage, or "-" when it did not apply.
 */
function rate(value: number | undefined): string {
  return value === undefined ? "-" : pct(value);
}

/**
 * Render a Stale-Knowledge Lifetime mean, a count of checkpoints, with one
 * decimal place, or a dash when it is `undefined` (no obsolete version was ever
 * forgotten on the trace, so there is no resolved lifetime to average).
 *
 * @param value - The mean resolved lifetime in checkpoints, or undefined.
 *
 * @returns The lifetime labelled in checkpoints, or "-" when absent.
 */
function lifetime(value: number | undefined): string {
  return value === undefined ? "-" : `${value.toFixed(1)} checkpoints`;
}

/**
 * Format a run result as a Markdown report: a headline score, the trace-level
 * quality and maintenance breakdown, the trace-level diagnostics, then a
 * per-checkpoint table of coverage, precision, and efficiency.
 *
 * @param result - The run result to render.
 *
 * @returns The Markdown report.
 */
export function formatReport(result: KebRunResult): string {
  const lines: string[] = [];
  const score = result.score;
  const rates = score.maintenanceRates;
  const diagnostics = result.diagnostics;

  lines.push(`# KEB report: ${result.metadata.benchmarkName}`);
  lines.push("");
  lines.push(`- Started: ${result.metadata.startedAt}`);
  lines.push(
    `- System: ${result.metadata.system.provider} / ${result.metadata.system.modelId ?? "(default)"}`,
  );
  lines.push(
    `- Evaluator: ${result.metadata.evaluatorModelId ?? "(default)"} (prompts ${result.metadata.evaluatorPromptVersion})`,
  );
  lines.push("");
  lines.push(`## KEB Score: ${pct(score.kebScore)}`);
  lines.push("");
  lines.push(
    `- Quality: ${pct(score.quality)} (harmonic mean of trace coverage and precision)`,
  );
  lines.push(`  - Trace Coverage: ${pct(score.traceCoverage)}`);
  lines.push(`  - Trace Precision: ${pct(score.tracePrecision)}`);
  lines.push(`- Maintenance: ${rate(score.maintenance)}`);
  lines.push(
    `  - New-Knowledge Discovery: ${rate(rates.newKnowledgeDiscovery)}`,
  );
  lines.push(
    `  - Changed-Knowledge Correction: ${rate(rates.changedKnowledgeCorrection)}`,
  );
  lines.push(`  - Complete Forgetting: ${rate(rates.completeForgetting)}`);
  lines.push(`  - Stable Retention: ${rate(rates.stableRetention)}`);
  lines.push("");
  lines.push("## Diagnostics");
  lines.push("");
  lines.push(
    "Trace-level behavior reported alongside the score, not part of it.",
  );
  lines.push("");
  lines.push(`- Recovery Rate: ${rate(diagnostics.recoveryRate)}`);
  lines.push(
    `- Stale-Knowledge Lifetime (mean over resolved versions): ${lifetime(diagnostics.staleKnowledge.meanResolvedLifetime)}`,
  );
  lines.push(
    `  - Unresolved obsolete versions: ${diagnostics.staleKnowledge.unresolvedCount}`,
  );
  lines.push("");
  lines.push("## Checkpoints");
  lines.push("");
  lines.push(
    "| Checkpoint | Coverage | Precision | Duration (ms) | Churn | Skipped |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- |");

  for (const checkpoint of result.checkpoints) {
    lines.push(
      `| ${checkpoint.checkpointId} | ${pct(checkpoint.coverage.score)} | ${pct(checkpoint.precision.score)} | ${checkpoint.efficiency.durationMs} | ${cell(checkpoint.efficiency.churnedLines)} | ${checkpoint.efficiency.skipped ? "yes" : "no"} |`,
    );
  }

  lines.push("");

  return `${lines.join("\n")}\n`;
}
