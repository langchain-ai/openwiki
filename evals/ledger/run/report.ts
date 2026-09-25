import type { LedgerRunResult, PrecisionVerdict } from "../core/types.js";
import {
  formatCount,
  formatLifetime,
  formatPercent1 as pct,
} from "./format.js";

function factForgettingRate(
  result: LedgerRunResult,
  checkpointId: string,
): string {
  const evaluations = result.checkpoints.find(
    (item) => item.checkpointId === checkpointId,
  )?.evaluations?.forgettingEvaluations;
  const judged = evaluations?.filter(
    (evaluation) => evaluation.verdict !== "indeterminate",
  );
  if (judged === undefined || judged.length === 0) {
    return "-";
  }
  const forgotten = judged.filter(
    (evaluation) => evaluation.verdict === "forgotten",
  ).length;
  return `${pct(forgotten / judged.length)} (${forgotten}/${judged.length})`;
}

function appendClaimClass(
  lines: string[],
  verdict: PrecisionVerdict,
  claims: NonNullable<
    LedgerRunResult["checkpoints"][number]["evaluations"]
  >["precisionEvaluations"],
): void {
  const matching = claims.filter(
    (claim) => claim.tense === "current" && claim.verdict === verdict,
  );
  const label = `${verdict[0].toUpperCase()}${verdict.slice(1)}`;
  lines.push(`- ${label} current claims (${matching.length}):`);
  if (matching.length === 0) {
    lines.push("  - none");
    return;
  }
  for (const claim of matching) {
    lines.push(
      `  - ${claim.location}: "${claim.assertion}" (${claim.rationale})`,
    );
  }
}

/** Format one completed run as an auditable Markdown report without inventing a
 * composite quality score. */
export function formatReport(result: LedgerRunResult): string {
  const lines: string[] = [
    `# LEDGER report: ${result.metadata.benchmarkName}`,
    "",
    `- Difficulty: ${result.metadata.difficulty}`,
    `- Started: ${result.metadata.startedAt}`,
    `- System: ${result.metadata.system.provider} / ${result.metadata.system.modelId ?? "(default)"}`,
    `- Evaluator: ${result.metadata.evaluatorModelId ?? "(default)"}`,
  ];
  if (result.metadata.reevaluatedFrom !== undefined) {
    lines.push(`- Re-evaluated from: ${result.metadata.reevaluatedFrom}`);
  }

  lines.push(`- LEDGER score: ${pct(result.score.value)}`);
  lines.push(`- Claim health: ${pct(result.score.claimHealth)}`);

  lines.push("", "## Checkpoints", "");
  lines.push(
    "| Checkpoint | Current claims | Supported | Stale | Hallucinated | Unverified | API forgetting | Evaluator | Duration (ms) | Churn | Skipped |",
  );
  lines.push(
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const checkpoint of result.checkpoints) {
    const claims = checkpoint.claims;
    lines.push(
      `| ${checkpoint.checkpointId} | ${claims.total} | ${pct(claims.supportedRate)} | ${pct(claims.stalenessRate)} (${claims.stale}) | ${pct(claims.hallucinationRate)} (${claims.invented}) | ${pct(claims.unverifiedRate)} (${claims.unverified}) | ${factForgettingRate(result, checkpoint.checkpointId)} | ${pct(checkpoint.evaluationCompleteness.rate)} | ${checkpoint.efficiency.durationMs} | ${formatCount(checkpoint.efficiency.churnedLines)} | ${checkpoint.efficiency.skipped ? "yes" : "no"} |`,
    );
  }

  lines.push("", "## Forgetting", "");
  lines.push(
    `- Mean resolved stale lifetime: ${formatLifetime(result.diagnostics.staleKnowledge.meanResolvedLifetime)}`,
  );
  lines.push(
    `- Obsolete API facts still unresolved: ${result.diagnostics.staleKnowledge.unresolvedCount}`,
  );

  lines.push("", "## Evaluation detail", "");
  for (const checkpoint of result.checkpoints) {
    const detail = checkpoint.evaluations;
    if (detail === undefined) continue;
    lines.push(`### ${checkpoint.checkpointId}`, "");
    appendClaimClass(lines, "invented", detail.precisionEvaluations);
    appendClaimClass(lines, "stale", detail.precisionEvaluations);
    appendClaimClass(lines, "unverified", detail.precisionEvaluations);
    if (detail.forgettingEvaluations.length > 0) {
      lines.push(`- API forgetting (${detail.forgettingEvaluations.length}):`);
      for (const item of detail.forgettingEvaluations) {
        lines.push(
          `  - \`${item.factVersionId}\` ${item.verdict}: ${item.rationale}`,
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
  return `${lines.join("\n")}\n`;
}
