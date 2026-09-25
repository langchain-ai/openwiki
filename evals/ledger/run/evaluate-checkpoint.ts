import {
  advanceObsoleteWatchSet,
  diffSurface,
  extractSurface,
  obsoleteTargetsFor,
} from "../benchmark/surface.js";
import type {
  CheckpointEvaluationRecord,
  CheckpointResult,
  EvaluationBackend,
  EvidenceCorpus,
  KnowledgeArtifact,
  LedgerCheckpoint,
  LedgerExecutionMetrics,
  ObsoleteFactTarget,
  SurfaceItem,
  SemanticEvidenceMap,
} from "../core/types.js";
import {
  computeClaimState,
  computeEvaluationCompleteness,
} from "../metrics/claims.js";
import { computeChurn } from "../metrics/churn.js";
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
   * transition, so no surface diff or obsolete facts are produced for it.
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

  /** Evaluator-only semantic topic-to-source routing metadata. */
  evidenceMap?: SemanticEvidenceMap;

  /**
   * The evaluation backend that produces the per-item verdicts.
   */
  evaluationBackend: EvaluationBackend;

  /**
   * The carry from the previous checkpoint.
   */
  carry: CheckpointCarry;

  /**
   * The System Under Test efficiency observations for this checkpoint, measured
   * live or copied from a saved run. Churn is recomputed here from the carry.
   */
  efficiency: LedgerExecutionMetrics;

  /**
   * Lifecycle observer for progress events.
   */
  reportProgress: BenchmarkProgressReporter;
}

/**
 * The outcome of evaluating one checkpoint: the measurements to record, history
 * entry to append, and the carry to pass to the next checkpoint.
 */
export interface EvaluatedCheckpoint {
  /**
   * The checkpoint measurements to append to the run result.
   */
  checkpointResult: CheckpointResult;

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
 * verdicts into current claim-state and evaluator-completeness measurements.
 * This is the loop body shared verbatim by the live runner and the
 * saved-run re-evaluator; the only per-caller differences (artifact/evidence
 * source and how efficiency is built) are passed in through the inputs.
 *
 * Sticky obsolete targets: once a version goes obsolete it stays in the watch set
 * for every later checkpoint, retired only when the requirements revive that
 * knowledge, so a version already judged forgotten is still re-checked later. That
 * is what lets the Stale-Knowledge Lifetime diagnostic measure how long stale
 * knowledge lingers.
 *
 * @param inputs - The checkpoint evaluation inputs.
 *
 * @returns The measurements, history entry, and next carry for this checkpoint.
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
    evidenceMap,
    evaluationBackend,
    carry,
    efficiency,
    reportProgress,
  } = inputs;

  const surface = await extractSurface(sourceRepoPath, checkpoint.commit);

  let newlyObsolete: ObsoleteFactTarget[] = [];

  if (
    index > 0 &&
    carry.previousCheckpointId !== undefined &&
    carry.previousSurface !== undefined
  ) {
    newlyObsolete = obsoleteTargetsFor(
      diffSurface(
        carry.previousSurface,
        surface,
        carry.previousCheckpointId,
        checkpoint.id,
      ),
    );
  }

  const obsoleteFacts = advanceObsoleteWatchSet({
    outstanding: carry.outstandingObsolete,
    surface,
    newlyObsolete,
  });

  reportProgress({
    type: "evaluation-start",
    checkpointId: checkpoint.id,
    obsoleteFactCount: obsoleteFacts.length,
  });

  const evaluation = await evaluationBackend.evaluate(
    {
      artifact,
      evidence,
      evidenceMap,
      obsoleteFacts,
    },
    {
      onClaimExtractionProgress: (completed, total) =>
        reportProgress({
          type: "claim-extraction-progress",
          checkpointId: checkpoint.id,
          completed,
          total,
          obsoleteFactCount: obsoleteFacts.length,
        }),
      onClaimEvaluationProgress: (claimCount, completed, total) =>
        reportProgress({
          type: "claim-evaluation-progress",
          checkpointId: checkpoint.id,
          claimCount,
          completed,
          total,
          obsoleteFactCount: obsoleteFacts.length,
        }),
    },
  );

  const claims = computeClaimState(evaluation.precisionEvaluations);
  const currentClaims = evaluation.precisionEvaluations.filter(
    (item) => item.tense === "current",
  );
  const evaluationCompleteness = computeEvaluationCompleteness(
    evaluation.precisionEvaluations,
    evaluation.forgettingEvaluations,
    evaluation.warnings ?? [],
  );

  reportProgress({
    type: "checkpoint-complete",
    checkpointId: checkpoint.id,
    claimCount: claims.total,
    supportedCount: claims.supported,
    staleCount: claims.stale,
    hallucinatedCount: claims.invented,
    unverifiedCount: claims.unverified,
    supportedRate: claims.supportedRate,
    stalenessRate: claims.stalenessRate,
    hallucinationRate: claims.hallucinationRate,
    unverifiedRate: claims.unverifiedRate,
    forgottenCount: evaluation.forgettingEvaluations.filter(
      (item) => item.verdict === "forgotten",
    ).length,
    obsoleteFactCount: evaluation.forgettingEvaluations.length,
    evaluationCompleteness: evaluationCompleteness.rate,
    indeterminateCount: evaluationCompleteness.indeterminate,
    evaluationItemCount: evaluationCompleteness.total,
    staleClaims: currentClaims
      .filter((item) => item.verdict === "stale")
      .map(({ location, assertion }) => ({ location, assertion })),
    hallucinatedClaims: currentClaims
      .filter((item) => item.verdict === "invented")
      .map(({ location, assertion }) => ({ location, assertion })),
  });

  const checkpointResult: CheckpointResult = {
    checkpointId: checkpoint.id,
    claims,
    evaluationCompleteness,
    efficiency: {
      ...efficiency,
      churnedLines: computeChurn(carry.previousArtifact, artifact),
    },
    // Retain the raw verdicts, not just their reduced counts, so each claim state
    // and forgetting result remains explainable in the persisted result.
    evaluations: {
      precisionEvaluations: evaluation.precisionEvaluations,
      forgettingEvaluations: evaluation.forgettingEvaluations,
      warnings: evaluation.warnings ?? [],
    },
  };

  const history: CheckpointEvaluationRecord = {
    forgettingEvaluations: evaluation.forgettingEvaluations,
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
  };

  return { checkpointResult, history, nextCarry };
}
