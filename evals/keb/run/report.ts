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
 * Render an assertion count with its fraction of validly judged assertions.
 *
 * @param count - Assertions in the displayed class.
 * @param judged - Complete validly judged assertion count.
 *
 * @returns Count followed by a percentage in parentheses.
 */
function assertionCount(count: number, judged: number): string {
  return `${count} (${pct(judged === 0 ? 0 : count / judged)})`;
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
  const precisionTotals = result.checkpoints.reduce(
    (totals, checkpoint) => ({
      ledgerSupported:
        totals.ledgerSupported + checkpoint.precision.ledgerSupported,
      sourceSupported:
        totals.sourceSupported + checkpoint.precision.sourceSupported,
      unsupported: totals.unsupported + checkpoint.precision.unsupported,
      contradicted: totals.contradicted + checkpoint.precision.contradicted,
      notEstablished:
        totals.notEstablished + checkpoint.precision.notEstablished,
      judged: totals.judged + checkpoint.precision.judged,
    }),
    {
      ledgerSupported: 0,
      sourceSupported: 0,
      unsupported: 0,
      contradicted: 0,
      notEstablished: 0,
      judged: 0,
    },
  );

  lines.push(`# KEB report: ${result.metadata.benchmarkName}`);
  lines.push("");
  lines.push(`- Started: ${result.metadata.startedAt}`);
  lines.push(
    `- System: ${result.metadata.system.provider} / ${result.metadata.system.modelId ?? "(default)"}`,
  );
  lines.push(`- Evaluator: ${result.metadata.evaluatorModelId ?? "(default)"}`);
  if (result.metadata.reevaluatedFrom !== undefined) {
    lines.push(`- Re-evaluated from: ${result.metadata.reevaluatedFrom}`);
  }
  lines.push("");
  lines.push(`## KEB Score: ${pct(score.kebScore)}`);
  lines.push("");
  lines.push(
    `- Quality: ${pct(score.quality)} (harmonic mean of trace coverage and precision)`,
  );
  lines.push(`  - Trace Coverage: ${pct(score.traceCoverage)}`);
  lines.push(`  - Trace Precision: ${pct(score.tracePrecision)}`);
  lines.push(
    `    - Required claims (ledger-backed): ${assertionCount(precisionTotals.ledgerSupported, precisionTotals.judged)}`,
  );
  lines.push(
    `    - Valid extras (source-backed): ${assertionCount(precisionTotals.sourceSupported, precisionTotals.judged)}`,
  );
  lines.push(
    `    - Unsupported: ${assertionCount(precisionTotals.unsupported, precisionTotals.judged)}`,
  );
  lines.push(
    `      - Hallucinated: ${assertionCount(precisionTotals.contradicted, precisionTotals.judged)}`,
  );
  lines.push(
    `      - Not established: ${assertionCount(precisionTotals.notEstablished, precisionTotals.judged)}`,
  );
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
  lines.push(`- Evaluator Completeness: ${pct(score.evaluationCompleteness)}`);
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
    "| Checkpoint | Coverage | Precision | Required claims | Valid extras | Unsupported | Hallucinated | Not established | Evaluator | Duration (ms) | Churn | Skipped |",
  );
  lines.push(
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );

  for (const checkpoint of result.checkpoints) {
    lines.push(
      `| ${checkpoint.checkpointId} | ${pct(checkpoint.coverage.score)} | ${pct(checkpoint.precision.score)} | ${checkpoint.precision.ledgerSupported} | ${checkpoint.precision.sourceSupported} | ${assertionCount(checkpoint.precision.unsupported, checkpoint.precision.judged)} | ${checkpoint.precision.contradicted} | ${checkpoint.precision.notEstablished} | ${pct(checkpoint.evaluationCompleteness.score)} | ${checkpoint.efficiency.durationMs} | ${cell(checkpoint.efficiency.churnedLines)} | ${checkpoint.efficiency.skipped ? "yes" : "no"} |`,
    );
  }

  lines.push("");
  appendEvaluationDetail(lines, result);

  return `${lines.join("\n")}\n`;
}

/**
 * Append the per-checkpoint evaluation detail behind the scores: the coverage
 * facts not stated correctly, unsupported artifact claims, and
 * forgetting verdicts. This turns a bare score into evidence a reader can act on
 * without treating evaluator failure as a system error.
 *
 * @param lines - The report lines accumulated so far, appended to in place.
 * @param result - The run result whose detail is rendered.
 */
function appendEvaluationDetail(lines: string[], result: KebRunResult): void {
  if (!result.checkpoints.some((checkpoint) => checkpoint.evaluations)) {
    return;
  }

  lines.push("## Evaluation detail");
  lines.push("");
  lines.push(
    "The raw verdicts behind the scores. Coverage lists material topics the artifact did not state correctly; precision lists unsupported claims with their diagnostic subtype; forgetting lists obsolete versions and whether the artifact dropped them.",
  );
  lines.push("");

  for (const checkpoint of result.checkpoints) {
    const detail = checkpoint.evaluations;

    if (detail === undefined) {
      continue;
    }

    lines.push(`### ${checkpoint.checkpointId}`);
    lines.push("");

    const coverageGaps = detail.factEvaluations.filter(
      (fact) => fact.verdict !== "correct",
    );
    lines.push(`- Coverage gaps (${coverageGaps.length}):`);
    if (coverageGaps.length === 0) {
      lines.push("  - none; every material topic is stated correctly");
    } else {
      for (const gap of coverageGaps) {
        lines.push(`  - \`${gap.factId}\` ${gap.verdict}: ${gap.rationale}`);
      }
    }

    const unsupported = detail.precisionEvaluations.filter(
      (assertion) => assertion.verdict === "unsupported",
    );
    lines.push(
      `- Unsupported assertions (${unsupported.length} of ${detail.precisionEvaluations.length}):`,
    );
    if (unsupported.length === 0) {
      lines.push("  - none");
    } else {
      for (const assertion of unsupported) {
        lines.push(
          `  - ${assertion.unsupportedReason === "contradicted" ? "hallucinated" : (assertion.unsupportedReason ?? "unspecified")} · ${assertion.location}: "${assertion.assertion}" (${assertion.rationale})`,
        );
      }
    }

    if (detail.forgettingEvaluations.length > 0) {
      lines.push(`- Forgetting (${detail.forgettingEvaluations.length}):`);
      for (const forgetting of detail.forgettingEvaluations) {
        lines.push(
          `  - \`${forgetting.factVersionId}\` ${forgetting.verdict}: ${forgetting.rationale}`,
        );
      }
    }

    const warnings = detail.warnings ?? [];
    if (warnings.length > 0) {
      lines.push(`- Evaluator warnings (${warnings.length}):`);
      for (const warning of warnings) {
        lines.push(
          `  - ${warning.pass} \`${warning.itemId}\`: ${warning.message}`,
        );
      }
    }

    lines.push("");
  }
}
