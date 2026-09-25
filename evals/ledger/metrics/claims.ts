import type {
  CheckpointEvaluationRecord,
  ClaimStateMetric,
  EvaluationCompletenessMetric,
  EvaluationWarning,
  ForgettingEvaluation,
  LedgerDiagnostics,
  PrecisionAssertionEvaluation,
  StaleKnowledgeDiagnostic,
  StaleKnowledgeRecord,
} from "../core/types.js";

/** Reduce every current-tense factual claim into one shared-denominator state
 * partition. Historical narration remains in the audit detail but cannot dilute
 * the snapshot-wide rates. */
export function computeClaimState(
  evaluations: PrecisionAssertionEvaluation[],
): ClaimStateMetric {
  const current = evaluations.filter((item) => item.tense === "current");
  const supported = current.filter(
    (item) => item.verdict === "supported",
  ).length;
  const invented = current.filter((item) => item.verdict === "invented").length;
  const stale = current.filter((item) => item.verdict === "stale").length;
  const unverified = current.filter(
    (item) => item.verdict === "unverified",
  ).length;
  const total = current.length;
  const rate = (count: number): number => (total === 0 ? 0 : count / total);
  return {
    supported,
    invented,
    stale,
    unverified,
    total,
    supportedRate: rate(supported),
    hallucinationRate: rate(invented),
    stalenessRate: rate(stale),
    unverifiedRate: rate(unverified),
  };
}

/** Measure evaluator reliability independently from wiki claim state. */
export function computeEvaluationCompleteness(
  precision: PrecisionAssertionEvaluation[],
  forgetting: ForgettingEvaluation[],
  warnings: EvaluationWarning[] = [],
): EvaluationCompletenessMetric {
  const extractionFailures = warnings.filter(
    (warning) => warning.pass === "precision-extraction",
  ).length;
  const judgmentFailures = warnings.filter(
    (warning) => warning.pass === "precision-judgment",
  ).length;
  const indeterminate =
    forgetting.filter((item) => item.verdict === "indeterminate").length +
    extractionFailures +
    judgmentFailures;
  // A grounding warning already has a degraded precision evaluation, and a
  // forgetting warning already has an indeterminate forgetting evaluation.
  // Only failed extraction units lack a corresponding result and extend the
  // denominator themselves.
  const total = precision.length + forgetting.length + extractionFailures;
  return {
    judged: total - indeterminate,
    indeterminate,
    total,
    rate: total === 0 ? 1 : (total - indeterminate) / total,
  };
}

/** Compute how many checkpoints each obsolete API fact remained current before
 * it was first forgotten. */
export function computeStaleKnowledge(
  history: CheckpointEvaluationRecord[],
): StaleKnowledgeDiagnostic {
  const lingered = new Map<string, number>();
  const resolved = new Set<string>();
  const order: string[] = [];
  for (const record of history) {
    for (const item of record.forgettingEvaluations) {
      if (!lingered.has(item.factVersionId)) {
        lingered.set(item.factVersionId, 0);
        order.push(item.factVersionId);
      }
      if (resolved.has(item.factVersionId)) continue;
      if (item.verdict === "lingering") {
        lingered.set(
          item.factVersionId,
          (lingered.get(item.factVersionId) ?? 0) + 1,
        );
      } else if (item.verdict === "forgotten") {
        resolved.add(item.factVersionId);
      }
    }
  }
  const records: StaleKnowledgeRecord[] = order.map((factVersionId) => ({
    factVersionId,
    lingeredCheckpoints: lingered.get(factVersionId) ?? 0,
    resolved: resolved.has(factVersionId),
  }));
  const lifetimes = records
    .filter((record) => record.resolved)
    .map((record) => record.lingeredCheckpoints);
  return {
    records,
    meanResolvedLifetime:
      lifetimes.length === 0
        ? undefined
        : lifetimes.reduce((sum, value) => sum + value, 0) / lifetimes.length,
    unresolvedCount: records.filter((record) => !record.resolved).length,
  };
}

/** Compute the forgetting diagnostics retained for the completed trace. */
export function computeDiagnostics(
  history: CheckpointEvaluationRecord[],
): LedgerDiagnostics {
  return { staleKnowledge: computeStaleKnowledge(history) };
}
