import type { LedgerRunResult, PrecisionVerdict } from "../core/types.js";
import { formatCount, formatLifetime, formatPercent } from "./format.js";

/**
 * Render a report metric fraction with the report's one-decimal precision.
 */
function pct(value: number | null | undefined): string {
  return formatPercent(value, 1);
}

/**
 * Render a claim-class count with its share of a denominator.
 *
 * @param count - Number of claims in the class.
 * @param denominator - Total claims the share is taken over.
 *
 * @returns The count and its parenthesized percentage, dash when undefined.
 */
function assertionCount(count: number, denominator: number): string {
  return `${count} (${pct(denominator === 0 ? null : count / denominator)})`;
}

/**
 * Compute one checkpoint's fact-side forgetting rate over judged versions.
 *
 * @param result - Complete run result.
 * @param checkpointId - Checkpoint to summarize.
 *
 * @returns Forgetting rate and counts, or a dash when nothing was judged.
 */
function factForgettingRate(
  result: LedgerRunResult,
  checkpointId: string,
): string {
  const evaluations = result.checkpoints.find(
    (checkpoint) => checkpoint.checkpointId === checkpointId,
  )?.evaluations?.forgettingEvaluations;
  if (evaluations === undefined) return "-";
  const judged = evaluations.filter(
    (evaluation) => evaluation.verdict !== "indeterminate",
  );
  if (judged.length === 0) return "-";
  const forgotten = judged.filter(
    (evaluation) => evaluation.verdict === "forgotten",
  ).length;
  return `${pct(forgotten / judged.length)} (${forgotten}/${judged.length})`;
}

/**
 * Format one complete benchmark result as an auditable Markdown report.
 */
export function formatReport(result: LedgerRunResult): string {
  const lines: string[] = [];
  const { score } = result;
  const rates = score.maintenanceRates;
  const diagnostics = result.diagnostics;
  const totals = result.checkpoints.reduce(
    (counts, checkpoint) => ({
      supported: counts.supported + checkpoint.precision.supported,
      invented: counts.invented + checkpoint.precision.invented,
      stale: counts.stale + checkpoint.precision.stale,
      unverified: counts.unverified + checkpoint.precision.unverified,
      adjudicated: counts.adjudicated + checkpoint.precision.adjudicated,
      total: counts.total + checkpoint.precision.total,
    }),
    {
      supported: 0,
      invented: 0,
      stale: 0,
      unverified: 0,
      adjudicated: 0,
      total: 0,
    },
  );

  lines.push(`# LEDGER report: ${result.metadata.benchmarkName}`);
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
  lines.push(`## LEDGER Score: ${pct(score.ledgerScore)}`);
  lines.push("");
  lines.push(
    `- Quality: ${pct(score.quality)} (harmonic mean of trace coverage and precision)`,
  );
  lines.push(`  - Trace Coverage: ${pct(score.traceCoverage)}`);
  lines.push(`  - Trace Precision: ${pct(score.tracePrecision)}`);
  lines.push(`  - Hallucination Rate: ${pct(score.traceHallucinationRate)}`);
  lines.push(`  - Staleness Rate: ${pct(score.traceStalenessRate)}`);
  lines.push(`  - Unverified Rate: ${pct(score.traceUnverifiedRate)}`);
  lines.push(
    `    - Supported: ${assertionCount(totals.supported, totals.adjudicated)}`,
  );
  lines.push(
    `    - Invented: ${assertionCount(totals.invented, totals.adjudicated)}`,
  );
  lines.push(
    `    - Stale: ${assertionCount(totals.stale, totals.adjudicated)}`,
  );
  lines.push(
    `    - Unverified: ${assertionCount(totals.unverified, totals.total)}`,
  );
  if (score.tracePrecision === null) {
    lines.push(
      "  - Warning: no checkpoint contained an adjudicated precision claim; precision, quality, and the benchmark score are undefined.",
    );
  }
  lines.push(`- Maintenance: ${pct(score.maintenance)}`);
  lines.push(
    `  - New-Knowledge Discovery: ${pct(rates.newKnowledgeDiscovery)}`,
  );
  lines.push(
    `  - Changed-Knowledge Correction: ${pct(rates.changedKnowledgeCorrection)}`,
  );
  lines.push(`  - Complete Forgetting: ${pct(rates.completeForgetting)}`);
  lines.push(`  - Stable Retention: ${pct(rates.stableRetention)}`);
  lines.push("");
  lines.push("## Diagnostics");
  lines.push("");
  lines.push(`- Evaluator Completeness: ${pct(score.evaluationCompleteness)}`);
  lines.push(`- Recovery Rate: ${pct(diagnostics.recoveryRate)}`);
  lines.push(
    `- Stale-Knowledge Lifetime (mean over resolved versions): ${formatLifetime(diagnostics.staleKnowledge.meanResolvedLifetime)}`,
  );
  lines.push(
    `  - Unresolved obsolete versions: ${diagnostics.staleKnowledge.unresolvedCount}`,
  );
  lines.push("");
  lines.push("## Checkpoints");
  lines.push("");
  lines.push(
    "| Checkpoint | Coverage | Precision | Hallucination | Claim staleness | Unverified | Fact forgetting | Adjudicated | Claims | Evaluator | Duration (ms) | Churn | Skipped |",
  );
  lines.push(
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const checkpoint of result.checkpoints) {
    lines.push(
      `| ${checkpoint.checkpointId} | ${pct(checkpoint.coverage.score)} | ${pct(checkpoint.precision.score)} | ${pct(checkpoint.precision.hallucinationRate)} | ${pct(checkpoint.precision.stalenessRate)} | ${pct(checkpoint.precision.unverifiedRate)} | ${factForgettingRate(result, checkpoint.checkpointId)} | ${checkpoint.precision.adjudicated} | ${checkpoint.precision.total} | ${pct(checkpoint.evaluationCompleteness.score)} | ${checkpoint.efficiency.durationMs} | ${formatCount(checkpoint.efficiency.churnedLines)} | ${checkpoint.efficiency.skipped ? "yes" : "no"} |`,
    );
  }

  lines.push("");
  appendEvaluationDetail(lines, result);
  return `${lines.join("\n")}\n`;
}

/**
 * Append one precision verdict class and its matching claims to the report.
 *
 * @param lines - Accumulating report lines, mutated in place.
 * @param verdict - Precision verdict class to render.
 * @param claims - All precision evaluations for the checkpoint.
 */
function appendClaimClass(
  lines: string[],
  verdict: PrecisionVerdict,
  claims: NonNullable<
    LedgerRunResult["checkpoints"][number]["evaluations"]
  >["precisionEvaluations"],
): void {
  const matching = claims.filter((claim) => claim.verdict === verdict);
  const label = `${verdict[0].toUpperCase()}${verdict.slice(1)}`;
  lines.push(`- ${label} claims (${matching.length} of ${claims.length}):`);
  if (matching.length === 0) {
    lines.push("  - none");
    return;
  }
  for (const claim of matching) {
    lines.push(
      `  - ${claim.tense} · ${claim.adjudicatedBy} · ${claim.location}: "${claim.assertion}" (${claim.rationale})`,
    );
  }
}

/**
 * Append the per-checkpoint evaluation-detail section when any checkpoint
 * carries evaluations.
 *
 * @param lines - Accumulating report lines, mutated in place.
 * @param result - Complete run result.
 */
function appendEvaluationDetail(
  lines: string[],
  result: LedgerRunResult,
): void {
  if (!result.checkpoints.some((checkpoint) => checkpoint.evaluations)) return;

  lines.push("## Evaluation detail");
  lines.push("");
  lines.push(
    "Coverage gaps, four-class claim judgments, fact-side forgetting, and evaluator warnings behind the score.",
  );
  lines.push("");

  for (const checkpoint of result.checkpoints) {
    const detail = checkpoint.evaluations;
    if (detail === undefined) continue;
    lines.push(`### ${checkpoint.checkpointId}`);
    lines.push("");
    const gaps = detail.factEvaluations.filter(
      (evaluation) => evaluation.verdict !== "correct",
    );
    lines.push(`- Coverage gaps (${gaps.length}):`);
    if (gaps.length === 0) {
      lines.push("  - none; every material topic is stated correctly");
    } else {
      for (const gap of gaps) {
        lines.push(`  - \`${gap.factId}\` ${gap.verdict}: ${gap.rationale}`);
      }
    }
    appendClaimClass(lines, "invented", detail.precisionEvaluations);
    appendClaimClass(lines, "stale", detail.precisionEvaluations);
    appendClaimClass(lines, "unverified", detail.precisionEvaluations);
    if (detail.forgettingEvaluations.length > 0) {
      lines.push(`- Fact forgetting (${detail.forgettingEvaluations.length}):`);
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
