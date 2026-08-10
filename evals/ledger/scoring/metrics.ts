import type {
  CheckpointEvaluationRecord,
  CheckpointScore,
  CheckpointTransitions,
  CoverageMetric,
  EvaluationCompletenessMetric,
  FactEvaluation,
  ForgettingEvaluation,
  LedgerDiagnostics,
  LedgerScore,
  MaintenanceCounts,
  MaintenanceRates,
  PrecisionAssertionEvaluation,
  PrecisionMetric,
  RateCount,
  StaleKnowledgeDiagnostic,
  StaleKnowledgeRecord,
} from "../core/types.js";

/**
 * Coverage over validly judged active material topics. Strict: only `correct`
 * earns headline credit; `partial`, `missing`, and `contradicted` are tallied as
 * diagnostics but never scored. Indeterminate evaluator output is excluded from
 * the semantic denominator and represented by Evaluator Completeness instead.
 * A checkpoint with no active coverage facts is invalid benchmark data, rejected
 * by `validateBenchmark` before any run.
 *
 * @param evaluations - The coverage verdicts.
 *
 * @returns The coverage metric.
 */
export function computeCoverage(evaluations: FactEvaluation[]): CoverageMetric {
  const correct = evaluations.filter((e) => e.verdict === "correct").length;
  const partial = evaluations.filter((e) => e.verdict === "partial").length;
  const missing = evaluations.filter((e) => e.verdict === "missing").length;
  const contradicted = evaluations.filter(
    (e) => e.verdict === "contradicted",
  ).length;
  const indeterminate = evaluations.filter(
    (e) => e.verdict === "indeterminate",
  ).length;
  const total = evaluations.length;
  const judged = total - indeterminate;
  const score = judged === 0 ? 0 : correct / judged;

  return {
    correct,
    partial,
    missing,
    contradicted,
    indeterminate,
    total,
    score,
  };
}

/**
 * Ledger-grounded precision over deduplicated material claims. Unverified claims
 * remain visible as a padding diagnostic but never enter a scored denominator.
 *
 * @param evaluations - The precision verdicts, one per material assertion.
 *
 * @returns The precision metric.
 */
export function computePrecision(
  evaluations: PrecisionAssertionEvaluation[],
): PrecisionMetric {
  const supported = evaluations.filter((e) => e.verdict === "supported").length;
  const invented = evaluations.filter((e) => e.verdict === "invented").length;
  const stale = evaluations.filter((e) => e.verdict === "stale").length;
  const unverified = evaluations.filter(
    (e) => e.verdict === "unverified",
  ).length;
  const total = evaluations.length;
  const adjudicated = supported + invented + stale;
  const score = adjudicated === 0 ? null : supported / adjudicated;
  const hallucinationRate = adjudicated === 0 ? null : invented / adjudicated;
  const stalenessRate = adjudicated === 0 ? null : stale / adjudicated;
  const unverifiedRate = total === 0 ? 0 : unverified / total;

  return {
    supported,
    invented,
    stale,
    unverified,
    adjudicated,
    total,
    hallucinationRate,
    stalenessRate,
    unverifiedRate,
    score,
  };
}

/**
 * Measure evaluator reliability independently from system quality. An
 * indeterminate verdict means a schema-valid batch item was malformed and an
 * isolated repair request also failed.
 *
 * @param coverage - Coverage judgments at one checkpoint.
 * @param precision - Precision judgments at one checkpoint.
 * @param forgetting - Forgetting judgments at one checkpoint.
 *
 * @returns Judged and indeterminate counts plus their completeness rate.
 */
export function computeEvaluationCompleteness(
  coverage: FactEvaluation[],
  precision: PrecisionAssertionEvaluation[],
  forgetting: ForgettingEvaluation[],
): EvaluationCompletenessMetric {
  const fallibleVerdicts = [
    ...coverage.map((evaluation) => evaluation.verdict),
    ...forgetting.map((evaluation) => evaluation.verdict),
  ];
  const indeterminate = fallibleVerdicts.filter(
    (verdict) => verdict === "indeterminate",
  ).length;
  const total = fallibleVerdicts.length + precision.length;
  const judged = total - indeterminate;

  return {
    judged,
    indeterminate,
    total,
    score: total === 0 ? 1 : judged / total,
  };
}

/**
 * The set of fact ids the wiki stated `correct` in a coverage pass.
 *
 * @param evaluations - Coverage verdicts.
 *
 * @returns The correct fact ids.
 */
function correctFactIds(evaluations: FactEvaluation[]): Set<string> {
  return new Set(
    evaluations.filter((e) => e.verdict === "correct").map((e) => e.factId),
  );
}

/**
 * The set of obsolete fact *version* ids the wiki successfully forgot.
 *
 * @param evaluations - Forgetting verdicts.
 *
 * @returns The forgotten version ids.
 */
function forgottenVersionIds(evaluations: ForgettingEvaluation[]): Set<string> {
  return new Set(
    evaluations
      .filter((e) => e.verdict === "forgotten")
      .map((e) => e.factVersionId),
  );
}

/**
 * Collect coverage fact IDs whose semantic judgment remained indeterminate.
 *
 * @param evaluations - Coverage verdicts.
 *
 * @returns Indeterminate fact IDs.
 */
function indeterminateFactIds(evaluations: FactEvaluation[]): Set<string> {
  return new Set(
    evaluations
      .filter((evaluation) => evaluation.verdict === "indeterminate")
      .map((evaluation) => evaluation.factId),
  );
}

/**
 * Collect obsolete version IDs whose forgetting judgment remained
 * indeterminate.
 *
 * @param evaluations - Forgetting verdicts.
 *
 * @returns Indeterminate obsolete version IDs.
 */
function indeterminateVersionIds(
  evaluations: ForgettingEvaluation[],
): Set<string> {
  return new Set(
    evaluations
      .filter((evaluation) => evaluation.verdict === "indeterminate")
      .map((evaluation) => evaluation.factVersionId),
  );
}

/**
 * Raw maintenance counts for one checkpoint boundary. Each rate is left as an
 * unreduced numerator over denominator so the trace-level rates can be summed
 * globally before any division; there is deliberately no per-checkpoint
 * maintenance score. Coverage is matched by `factId` at the relevant checkpoint;
 * forgetting is matched by obsolete `factVersionId`.
 *
 * The success conditions are:
 *
 * - Discovery: an introduced fact is `correct` now.
 * - Correction: a changed fact's new version is `correct` now AND its previous
 *   version is forgotten. A changed fact's obsolete version is counted only here,
 *   never under forgetting, so no forgetting is double-counted.
 * - Complete Forgetting: a removed fact's previous version is forgotten.
 * - Retention: a stable fact that was `correct` at the previous checkpoint is
 *   still `correct` now. Only facts correct at the previous checkpoint are
 *   eligible, so retention never rewards facts the wiki never had.
 *
 * A transition whose required current judgment is indeterminate is excluded
 * from its semantic denominator and represented by Evaluator Completeness.
 *
 * @param transitions - The structured transitions across this boundary.
 * @param currentCoverage - Coverage verdicts at the current checkpoint.
 * @param forgetting - Forgetting verdicts at the current checkpoint.
 * @param previousCoverage - Coverage verdicts at the previous checkpoint, needed
 *   for retention eligibility.
 *
 * @returns The raw maintenance counts.
 */
export function computeMaintenanceCounts(
  transitions: CheckpointTransitions,
  currentCoverage: FactEvaluation[],
  forgetting: ForgettingEvaluation[],
  previousCoverage: FactEvaluation[],
): MaintenanceCounts {
  const currentCorrect = correctFactIds(currentCoverage);
  const previousCorrect = correctFactIds(previousCoverage);
  const forgottenVersions = forgottenVersionIds(forgetting);
  const indeterminateFacts = indeterminateFactIds(currentCoverage);
  const indeterminateVersions = indeterminateVersionIds(forgetting);
  const eligibleIntroduced = transitions.introduced.filter(
    (fact) => !indeterminateFacts.has(fact.factId),
  );

  const discovery: RateCount = {
    numerator: eligibleIntroduced.filter((f) => currentCorrect.has(f.factId))
      .length,
    denominator: eligibleIntroduced.length,
  };

  const eligibleChanged = transitions.changed.filter(
    (fact) =>
      !indeterminateFacts.has(fact.factId) &&
      !indeterminateVersions.has(fact.previousVersionId),
  );
  const correction: RateCount = {
    numerator: eligibleChanged.filter(
      (f) =>
        currentCorrect.has(f.factId) &&
        forgottenVersions.has(f.previousVersionId),
    ).length,
    denominator: eligibleChanged.length,
  };

  const eligibleRemoved = transitions.removed.filter(
    (fact) => !indeterminateVersions.has(fact.previousVersionId),
  );
  const completeForgetting: RateCount = {
    numerator: eligibleRemoved.filter((f) =>
      forgottenVersions.has(f.previousVersionId),
    ).length,
    denominator: eligibleRemoved.length,
  };

  const eligibleStable = transitions.stable.filter(
    (f) => previousCorrect.has(f.factId) && !indeterminateFacts.has(f.factId),
  );
  const retention: RateCount = {
    numerator: eligibleStable.filter((f) => currentCorrect.has(f.factId))
      .length,
    denominator: eligibleStable.length,
  };

  return {
    newKnowledgeDiscovery: discovery,
    changedKnowledgeCorrection: correction,
    completeForgetting,
    stableRetention: retention,
  };
}

/**
 * Sum a set of raw counts and reduce them to a single rate, or undefined when the
 * global denominator is 0 (the dimension never occurred on the trace).
 *
 * @param counts - The per-boundary raw counts for one dimension.
 *
 * @returns The global rate, or undefined.
 */
function globalRate(counts: RateCount[]): number | undefined {
  const numerator = counts.reduce((sum, c) => sum + c.numerator, 0);
  const denominator = counts.reduce((sum, c) => sum + c.denominator, 0);

  return denominator === 0 ? undefined : numerator / denominator;
}

/**
 * Aggregate every boundary's raw counts into the four trace-level maintenance
 * rates by summing numerators and denominators across the whole trace and
 * dividing once. A dimension whose global denominator is 0 is left undefined.
 *
 * @param counts - The per-boundary maintenance counts, in trace order.
 *
 * @returns The trace-level rates.
 */
function aggregateMaintenanceRates(
  counts: MaintenanceCounts[],
): MaintenanceRates {
  return {
    newKnowledgeDiscovery: globalRate(
      counts.map((c) => c.newKnowledgeDiscovery),
    ),
    changedKnowledgeCorrection: globalRate(
      counts.map((c) => c.changedKnowledgeCorrection),
    ),
    completeForgetting: globalRate(counts.map((c) => c.completeForgetting)),
    stableRetention: globalRate(counts.map((c) => c.stableRetention)),
  };
}

/**
 * Aggregate per-checkpoint scores into the final LEDGER Score. Trace Coverage and
 * trace Precision are checkpoint macro-averages; Quality is their harmonic mean.
 * Maintenance rates are computed globally from summed raw counts, then the
 * defined rates are averaged for the Maintenance Score. The LEDGER Score is the mean
 * of Quality and Maintenance, or Quality alone when the trace has no maintenance
 * boundary. All fields are fractions in [0, 1]; the report renders them as 0 to
 * 100.
 *
 * @param checkpoints - The per-checkpoint scores, in trace order.
 *
 * @returns The aggregate score.
 */
export function aggregateScore(checkpoints: CheckpointScore[]): LedgerScore {
  const traceCoverage = mean(checkpoints.map((c) => c.coverage.score));
  const tracePrecision = meanDefined(checkpoints.map((c) => c.precision.score));
  const traceHallucinationRate = meanDefined(
    checkpoints.map((c) => c.precision.hallucinationRate),
  );
  const traceStalenessRate = meanDefined(
    checkpoints.map((c) => c.precision.stalenessRate),
  );
  const traceUnverifiedRate = mean(
    checkpoints.map((c) => c.precision.unverifiedRate),
  );
  const quality =
    tracePrecision === null
      ? null
      : harmonicMean(traceCoverage, tracePrecision);
  const completenessTotals = checkpoints.reduce(
    (totals, checkpoint) => ({
      judged: totals.judged + checkpoint.evaluationCompleteness.judged,
      total: totals.total + checkpoint.evaluationCompleteness.total,
    }),
    { judged: 0, total: 0 },
  );
  const evaluationCompleteness =
    completenessTotals.total === 0
      ? 1
      : completenessTotals.judged / completenessTotals.total;

  const maintenanceRates = aggregateMaintenanceRates(
    checkpoints
      .map((c) => c.maintenanceCounts)
      .filter((counts): counts is MaintenanceCounts => counts !== undefined),
  );

  const definedRates = [
    maintenanceRates.newKnowledgeDiscovery,
    maintenanceRates.changedKnowledgeCorrection,
    maintenanceRates.completeForgetting,
    maintenanceRates.stableRetention,
  ].filter((rate): rate is number => rate !== undefined);

  const maintenance =
    definedRates.length === 0
      ? undefined
      : definedRates.reduce((sum, rate) => sum + rate, 0) / definedRates.length;

  const ledgerScore =
    quality === null
      ? null
      : maintenance === undefined
        ? quality
        : (quality + maintenance) / 2;

  return {
    traceCoverage,
    tracePrecision,
    traceHallucinationRate,
    traceStalenessRate,
    traceUnverifiedRate,
    evaluationCompleteness,
    quality,
    maintenanceRates,
    maintenance,
    ledgerScore,
  };
}

/**
 * Recovery Rate: of the maintenance transitions that failed at their own
 * boundary, the fraction a later checkpoint made good. A transition is assessed
 * at the checkpoint it lands on using the same success condition its maintenance
 * rate uses, and it is eligible only when that condition failed there:
 *
 * - Introduced: eligible when the fact is not `correct` at its boundary; recovers
 *   when the fact reads `correct` at any later checkpoint.
 * - Changed: eligible when the new version is not `correct` or the obsolete
 *   version is not forgotten at the boundary; recovers when a later checkpoint has
 *   the fact `correct` AND the obsolete version forgotten.
 * - Removed: eligible when the obsolete version is not forgotten at the boundary;
 *   recovers when it is forgotten at any later checkpoint.
 *
 * Stable-retention regressions are deliberately excluded in V1. A transition
 * with an indeterminate boundary judgment is not classified as a failure.
 * Coverage is matched by `factId` and forgetting by obsolete `factVersionId`,
 * exactly as the maintenance counts match them. A trace-level diagnostic, never
 * part of the LEDGER Score.
 *
 * @param history - The per-checkpoint evaluation records, in trace order.
 *
 * @returns The recovery rate in [0, 1], or undefined when no transition failed at
 *   its boundary, so nothing was eligible to recover.
 */
export function computeRecoveryRate(
  history: CheckpointEvaluationRecord[],
): number | undefined {
  const correctByIndex = history.map((record) =>
    correctFactIds(record.factEvaluations),
  );

  // The versions judged `forgotten` at each checkpoint, read per checkpoint
  // rather than accumulated. LEDGER does not treat forgetting as permanent: an
  // obsolete version stays under watch and can be judged `lingering` again after
  // an earlier `forgotten`, so recovery is decided from the verdict at each
  // checkpoint, not from whether the version had ever been forgotten by then.
  const forgottenByIndex = history.map((record) =>
    forgottenVersionIds(record.forgettingEvaluations),
  );
  const indeterminateFactsByIndex = history.map((record) =>
    indeterminateFactIds(record.factEvaluations),
  );
  const indeterminateVersionsByIndex = history.map((record) =>
    indeterminateVersionIds(record.forgettingEvaluations),
  );

  const correctAt = (index: number, factId: string): boolean =>
    correctByIndex[index].has(factId);
  const forgottenAt = (index: number, factVersionId: string): boolean =>
    forgottenByIndex[index].has(factVersionId);

  let eligible = 0;
  let recovered = 0;

  history.forEach((record, boundary) => {
    const transitions = record.transitions;

    if (transitions === undefined) {
      return;
    }

    // A transition that failed at its boundary is eligible; it recovers if its
    // success condition holds at any strictly later checkpoint. For a changed
    // fact the new version being correct and the old being forgotten must hold at
    // the same later checkpoint, mirroring the correction success condition; a
    // stale earlier forgetting does not carry forward if the old version lingers
    // again.
    const assess = (succeedsAt: (index: number) => boolean): void => {
      if (succeedsAt(boundary)) {
        return;
      }

      eligible += 1;

      for (let index = boundary + 1; index < history.length; index += 1) {
        if (succeedsAt(index)) {
          recovered += 1;
          return;
        }
      }
    };

    for (const fact of transitions.introduced) {
      if (indeterminateFactsByIndex[boundary].has(fact.factId)) {
        continue;
      }
      assess((index) => correctAt(index, fact.factId));
    }

    for (const fact of transitions.changed) {
      if (
        indeterminateFactsByIndex[boundary].has(fact.factId) ||
        indeterminateVersionsByIndex[boundary].has(fact.previousVersionId)
      ) {
        continue;
      }
      assess(
        (index) =>
          correctAt(index, fact.factId) &&
          forgottenAt(index, fact.previousVersionId),
      );
    }

    for (const fact of transitions.removed) {
      if (indeterminateVersionsByIndex[boundary].has(fact.previousVersionId)) {
        continue;
      }
      assess((index) => forgottenAt(index, fact.previousVersionId));
    }
  });

  return eligible === 0 ? undefined : recovered / eligible;
}

/**
 * Stale-Knowledge Lifetime: how many checkpoints each obsolete fact version kept
 * lingering in the wiki after it became obsolete, before it was first judged
 * forgotten. Forgetting is not treated as permanent, so a version can linger
 * again after a first forgetting; those recurrences stay in the raw forgetting
 * history but do not extend the measured lifetime, which stops at the first
 * forgetting. One record is kept per obsolete version, in first-seen order,
 * carrying its lingering count and whether it was ever forgotten. The summary mean
 * is taken over resolved (forgotten) versions only; obsolete versions left
 * unresolved when observation stopped (never judged forgotten, whether the trace
 * ended or the fact was revived) are counted in `unresolvedCount` and never folded
 * into the mean, so an unknown final lifetime is never treated as known. A
 * An indeterminate forgetting judgment neither increments the lifetime nor
 * resolves it. Evaluator Completeness reports that gap. A trace-level diagnostic,
 * never part of the LEDGER Score.
 *
 * @param history - The per-checkpoint evaluation records, in trace order.
 *
 * @returns The per-version records and their summary.
 */
export function computeStaleKnowledge(
  history: CheckpointEvaluationRecord[],
): StaleKnowledgeDiagnostic {
  const lingered = new Map<string, number>();
  const resolved = new Set<string>();
  const order: string[] = [];

  for (const record of history) {
    for (const evaluation of record.forgettingEvaluations) {
      if (!lingered.has(evaluation.factVersionId)) {
        lingered.set(evaluation.factVersionId, 0);
        order.push(evaluation.factVersionId);
      }

      // Lifetime is the time until a version is *first* forgotten. Once it has
      // been forgotten, later verdicts (an obsolete version that recurs) are left
      // in the raw forgetting history but do not extend the measured lifetime.
      if (resolved.has(evaluation.factVersionId)) {
        continue;
      }

      if (evaluation.verdict === "lingering") {
        lingered.set(
          evaluation.factVersionId,
          (lingered.get(evaluation.factVersionId) ?? 0) + 1,
        );
      } else if (evaluation.verdict === "forgotten") {
        resolved.add(evaluation.factVersionId);
      }
    }
  }

  const records: StaleKnowledgeRecord[] = order.map((factVersionId) => ({
    factVersionId,
    lingeredCheckpoints: lingered.get(factVersionId) ?? 0,
    resolved: resolved.has(factVersionId),
  }));

  const resolvedLifetimes = records
    .filter((record) => record.resolved)
    .map((record) => record.lingeredCheckpoints);

  const meanResolvedLifetime =
    resolvedLifetimes.length === 0
      ? undefined
      : resolvedLifetimes.reduce((sum, value) => sum + value, 0) /
        resolvedLifetimes.length;

  return {
    records,
    meanResolvedLifetime,
    unresolvedCount: records.filter((record) => !record.resolved).length,
  };
}

/**
 * Compute the trace-level diagnostics from the full evaluation history.
 *
 * @param history - The per-checkpoint evaluation records, in trace order.
 *
 * @returns The diagnostics.
 */
export function computeDiagnostics(
  history: CheckpointEvaluationRecord[],
): LedgerDiagnostics {
  return {
    recoveryRate: computeRecoveryRate(history),
    staleKnowledge: computeStaleKnowledge(history),
  };
}

/**
 * The harmonic mean of two fractions, or 0 when either is 0. Punishes imbalance:
 * an artifact that covers everything but contains contradicted claims, or is
 * perfectly precise but says almost nothing, scores poorly.
 *
 * @param a - The first fraction.
 * @param b - The second fraction.
 *
 * @returns The harmonic mean, or 0.
 */
function harmonicMean(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : (2 * a * b) / (a + b);
}

/**
 * Arithmetic mean, 0 for an empty set. The trace always has at least one
 * checkpoint, so this only guards a degenerate call.
 *
 * @param values - The values to average.
 *
 * @returns The mean, or 0 when empty.
 */
function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Average defined nullable rates, returning null when none are defined. */
function meanDefined(values: Array<number | null>): number | null {
  const defined = values.filter((value): value is number => value !== null);
  return defined.length === 0 ? null : mean(defined);
}
