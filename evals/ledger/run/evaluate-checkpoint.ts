import {
  advanceObsoleteWatchSet,
  diffSurface,
  extractSurface,
  obsoleteTargetsFor,
} from "../benchmark/surface.js";
import type {
  CheckpointEvaluationRecord,
  CheckpointScore,
  CheckpointTransitions,
  EvaluationBackend,
  EvidenceCorpus,
  FactEvaluation,
  KnowledgeArtifact,
  LedgerCheckpoint,
  LedgerExecutionMetrics,
  MaintenanceCounts,
  ObsoleteFactTarget,
  SurfaceItem,
} from "../core/types.js";
import {
  computeCoverage,
  computeEvaluationCompleteness,
  computeMaintenanceCounts,
  computePrecision,
} from "../scoring/metrics.js";
import type { BenchmarkProgressReporter } from "./progress-events.js";

/**
 * Mutable state carried from one checkpoint to the next as the trace is walked.
 * Each evaluated checkpoint reads the previous checkpoint's carry and produces
 * the next one, so the sticky obsolete watch set and the temporal surface diff
 * stay correct across the whole run.
 */
export interface CheckpointCarry {
  /**
   * The artifact captured at the previous checkpoint, used to measure churn.
   *
   * @default undefined the first checkpoint has no prior artifact
   */
  previousArtifact: KnowledgeArtifact | undefined;

  /**
   * The previous checkpoint's id, used as the "from" side of the surface diff.
   *
   * @default undefined the first checkpoint has no inbound transition
   */
  previousCheckpointId: string | undefined;

  /**
   * The previous checkpoint's extracted surface, diffed against the current one
   * to detect transitions.
   *
   * @default undefined the first checkpoint has no prior surface
   */
  previousSurface: SurfaceItem[] | undefined;

  /**
   * The previous checkpoint's fact evaluations, used by maintenance scoring to
   * detect revived knowledge across the boundary.
   */
  previousFactEvaluations: FactEvaluation[];

  /**
   * Obsolete fact versions still under the forgetting watch set entering this
   * checkpoint. Sticky: a version stays until the requirements revive it.
   */
  outstandingObsolete: ObsoleteFactTarget[];
}

/**
 * The starting carry for the first checkpoint of a run: no prior artifact,
 * checkpoint, or surface, and empty fact-evaluation and obsolete-watch sets.
 *
 * @returns A fresh carry with every history field cleared.
 */
export function initialCarry(): CheckpointCarry {
  return {
    previousArtifact: undefined,
    previousCheckpointId: undefined,
    previousSurface: undefined,
    previousFactEvaluations: [],
    outstandingObsolete: [],
  };
}

/**
 * Everything one checkpoint evaluation needs. The artifact, evidence, and
 * efficiency are supplied by the caller because they are the only things that
 * differ between a live run (captured from the System Under Test) and a
 * re-evaluation (loaded from a saved run); everything else is identical.
 */
export interface EvaluateCheckpointInputs {
  /**
   * Absolute path to the benchmark's source repository, read at the checkpoint
   * commit to extract the scorable surface.
   */
  sourceRepoPath: string;

  /**
   * The checkpoint being evaluated (its id and commit are used).
   */
  checkpoint: LedgerCheckpoint;

  /**
   * Zero-based position of this checkpoint in the trace. Index 0 has no inbound
   * transition, so no surface diff or maintenance counts are produced for it.
   */
  index: number;

  /**
   * The immutable wiki artifact under evaluation at this checkpoint.
   */
  artifact: KnowledgeArtifact;

  /**
   * The source evidence (current and historical) grounding precision judgments.
   */
  evidence: EvidenceCorpus;

  /**
   * The evaluation backend that produces the per-item verdicts.
   */
  evaluationBackend: EvaluationBackend;

  /**
   * The carry from the previous checkpoint.
   */
  carry: CheckpointCarry;

  /**
   * The System Under Test efficiency observations for this checkpoint, built by
   * the caller (measured live, or copied from a saved run with churn recomputed).
   */
  efficiency: LedgerExecutionMetrics;

  /**
   * Lifecycle observer for progress events.
   */
  reportProgress: BenchmarkProgressReporter;
}

/**
 * The outcome of evaluating one checkpoint: the score to record, the history
 * entry to append, and the carry to pass to the next checkpoint.
 */
export interface EvaluatedCheckpoint {
  /**
   * The checkpoint score to push onto the run's score list.
   */
  score: CheckpointScore;

  /**
   * The evaluation record to push onto the run's history, feeding diagnostics.
   */
  history: CheckpointEvaluationRecord;

  /**
   * The carry to hand to the next checkpoint.
   */
  nextCarry: CheckpointCarry;
}

/**
 * Evaluate a single checkpoint: extract its source surface, diff it against the
 * previous checkpoint to derive transitions and newly obsolete versions, advance
 * the sticky forgetting watch set, run the evaluation backend, and reduce the raw
 * verdicts into coverage, precision, evaluation-completeness, and maintenance
 * counts. This is the loop body shared verbatim by the live runner and the
 * saved-run re-evaluator; the only per-caller differences (artifact/evidence
 * source and how efficiency is built) are passed in through the inputs.
 *
 * Sticky obsolete targets: once a version goes obsolete it stays in the watch set
 * for every later checkpoint, retired only when the requirements revive that
 * knowledge, so a version already judged forgotten is still re-checked later. That
 * is what lets the Stale-Knowledge Lifetime diagnostic measure how long stale
 * knowledge lingers; it does not affect the Maintenance Score, because
 * `computeMaintenanceCounts` only matches forgetting verdicts against the current
 * boundary's own obsolete versions.
 *
 * @param inputs - The checkpoint evaluation inputs.
 *
 * @returns The score, history entry, and next carry for this checkpoint.
 */
export async function evaluateCheckpoint(
  inputs: EvaluateCheckpointInputs,
): Promise<EvaluatedCheckpoint> {
  const {
    sourceRepoPath,
    checkpoint,
    index,
    artifact,
    evidence,
    evaluationBackend,
    carry,
    efficiency,
    reportProgress,
  } = inputs;

  const surface = await extractSurface(sourceRepoPath, checkpoint.commit);

  let transitions: CheckpointTransitions | undefined;
  let newlyObsolete: ObsoleteFactTarget[] = [];

  if (
    index > 0 &&
    carry.previousCheckpointId !== undefined &&
    carry.previousSurface !== undefined
  ) {
    transitions = diffSurface(
      carry.previousSurface,
      surface,
      carry.previousCheckpointId,
      checkpoint.id,
    );
    newlyObsolete = obsoleteTargetsFor(transitions);
  }

  const obsoleteFacts = advanceObsoleteWatchSet({
    outstanding: carry.outstandingObsolete,
    surface,
    newlyObsolete,
  });

  reportProgress({
    type: "evaluation-start",
    checkpointId: checkpoint.id,
    surfaceItemCount: surface.length,
    obsoleteFactCount: obsoleteFacts.length,
  });

  const evaluation = await evaluationBackend.evaluate({
    artifact,
    surface,
    evidence,
    obsoleteFacts,
    transitions,
  });

  const coverage = computeCoverage(evaluation.factEvaluations);
  const precision = computePrecision(evaluation.precisionEvaluations);
  const evaluationCompleteness = computeEvaluationCompleteness(
    evaluation.factEvaluations,
    evaluation.precisionEvaluations,
    evaluation.forgettingEvaluations,
  );

  reportProgress({
    type: "checkpoint-complete",
    checkpointId: checkpoint.id,
    coverageScore: coverage.score,
    precisionScore: precision.score,
    hallucinationRate: precision.hallucinationRate,
    forgottenCount: evaluation.forgettingEvaluations.filter(
      (item) => item.verdict === "forgotten",
    ).length,
    obsoleteFactCount: evaluation.forgettingEvaluations.length,
    evaluationCompleteness: evaluationCompleteness.score,
    indeterminateCount: evaluationCompleteness.indeterminate,
    evaluationItemCount: evaluationCompleteness.total,
  });

  let maintenanceCounts: MaintenanceCounts | undefined;

  if (transitions !== undefined) {
    maintenanceCounts = computeMaintenanceCounts(
      transitions,
      evaluation.factEvaluations,
      evaluation.forgettingEvaluations,
      carry.previousFactEvaluations,
    );
  }

  const score: CheckpointScore = {
    checkpointId: checkpoint.id,
    coverage,
    precision,
    evaluationCompleteness,
    maintenanceCounts,
    efficiency,
    // Retain the raw verdicts, not just their reduced counts, so a score is
    // explainable: precision classes remain distinguishable, and forgetting
    // verdicts make an otherwise invisible pass visible in the persisted result.
    evaluations: {
      factEvaluations: evaluation.factEvaluations,
      precisionEvaluations: evaluation.precisionEvaluations,
      forgettingEvaluations: evaluation.forgettingEvaluations,
      warnings: evaluation.warnings ?? [],
    },
  };

  const history: CheckpointEvaluationRecord = {
    checkpointId: checkpoint.id,
    factEvaluations: evaluation.factEvaluations,
    forgettingEvaluations: evaluation.forgettingEvaluations,
    transitions,
  };

  const nextCarry: CheckpointCarry = {
    // Keep every obsolete version under watch, including ones just judged
    // forgotten: LEDGER does not treat forgetting as permanent, so a version stays
    // in the forgetting pass until the requirements revive it (the revival filter
    // in advanceObsoleteWatchSet is the only way a target leaves the watch set).
    outstandingObsolete: obsoleteFacts,
    previousArtifact: artifact,
    previousCheckpointId: checkpoint.id,
    previousSurface: surface,
    previousFactEvaluations: evaluation.factEvaluations,
  };

  return { score, history, nextCarry };
}
