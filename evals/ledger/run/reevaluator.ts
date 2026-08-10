import path from "node:path";

import {
  advanceObsoleteWatchSet,
  diffSurface,
  extractSurface,
  obsoleteTargetsFor,
} from "../benchmark/surface.js";
import { LedgerError } from "../core/errors.js";
import type {
  CheckpointEvaluationRecord,
  CheckpointScore,
  CheckpointTransitions,
  EvidenceCorpus,
  EvaluationBackend,
  FactEvaluation,
  LedgerBenchmark,
  LedgerRunResult,
  KnowledgeArtifact,
  MaintenanceCounts,
  ObsoleteFactTarget,
  SurfaceItem,
} from "../core/types.js";
import { computeChurn } from "../scoring/churn.js";
import {
  aggregateScore,
  computeCoverage,
  computeDiagnostics,
  computeEvaluationCompleteness,
  computeMaintenanceCounts,
  computePrecision,
} from "../scoring/metrics.js";
import type { BenchmarkProgressReporter } from "./progress-events.js";
import {
  loadSavedArtifact,
  loadSavedEvidence,
  loadSavedRunResult,
} from "./saved-run.js";

/**
 * Inputs for semantic re-evaluation of an already-generated LEDGER run.
 */
export interface SavedRunReevaluationInputs {
  /**
   * Validated benchmark whose requirements and trace define the evaluation.
   */
  benchmark: LedgerBenchmark;

  /**
   * Completed run directory containing artifact and evidence snapshots.
   */
  sourceRunDir: string;

  /**
   * Evaluation backend to apply to the saved inputs.
   */
  evaluationBackend: EvaluationBackend;

  /**
   * Provider id used by the evaluator model.
   */
  provider: string;

  /**
   * Concrete evaluator model id.
   */
  evaluatorModelId: string;

  /**
   * ISO-8601 timestamp identifying the new evaluation run.
   */
  startedAt: string;

  /**
   * Lifecycle observer used by command-line progress output.
   *
   * @default undefined lifecycle events are discarded
   */
  onProgress?: BenchmarkProgressReporter;

  /**
   * Durable sink for each loaded artifact copied into the new run.
   *
   * @default undefined loaded artifacts are not re-persisted
   */
  onArtifact?: (artifact: KnowledgeArtifact) => void | Promise<void>;

  /**
   * Durable sink for each loaded evidence corpus copied into the new run.
   *
   * @default undefined loaded evidence is not re-persisted
   */
  onEvidence?: (evidence: EvidenceCorpus) => void | Promise<void>;
}

/**
 * Resolve the original checkpoint score used only for immutable System Under
 * Test efficiency observations. Semantic scores and verdicts are never reused.
 *
 * @param savedResult - Original completed run result.
 * @param checkpointId - Checkpoint to resolve.
 *
 * @returns The matching saved checkpoint.
 *
 * @throws LedgerError when the saved run lacks the required checkpoint.
 */
function savedCheckpoint(
  savedResult: LedgerRunResult,
  checkpointId: string,
): CheckpointScore {
  const checkpoint = savedResult.checkpoints.find(
    (candidate) => candidate.checkpointId === checkpointId,
  );

  if (checkpoint === undefined || checkpoint.efficiency === undefined) {
    throw new LedgerError(
      `Saved run has no execution observations for checkpoint "${checkpointId}".`,
    );
  }

  return checkpoint;
}

/**
 * Re-run only semantic evaluation over immutable artifacts and source evidence
 * from a completed LEDGER run. Source surface extraction, temporal transitions,
 * forgetting watch sets, all per-item judgments, and every score are recomputed.
 * The System Under Test is never invoked.
 *
 * @param inputs - Saved-run evaluation inputs.
 *
 * @returns A new independently persisted run result.
 *
 * @throws LedgerError when the saved run does not match the selected benchmark.
 */
export async function reevaluateSavedRun(
  inputs: SavedRunReevaluationInputs,
): Promise<LedgerRunResult> {
  const sourceRunDir = path.resolve(inputs.sourceRunDir);
  const savedResult = await loadSavedRunResult(sourceRunDir);
  const checkpoints = inputs.benchmark.trace.checkpoints;
  const reportProgress = inputs.onProgress ?? (() => undefined);

  if (savedResult.metadata.benchmarkName !== inputs.benchmark.name) {
    throw new LedgerError(
      `Saved run benchmark "${savedResult.metadata.benchmarkName}" does not match "${inputs.benchmark.name}".`,
    );
  }

  reportProgress({
    type: "run-start",
    benchmarkName: inputs.benchmark.name,
    difficulty: inputs.benchmark.difficulty,
    totalCheckpoints: checkpoints.length,
    provider: inputs.provider,
    systemModelId: savedResult.metadata.system.modelId,
    evaluatorModelId: inputs.evaluatorModelId,
    evaluationOnly: true,
  });
  reportProgress({ type: "replay-ready", saved: true });

  try {
    const scores: CheckpointScore[] = [];
    const history: CheckpointEvaluationRecord[] = [];
    let previousArtifact: KnowledgeArtifact | undefined;
    let previousCheckpointId: string | undefined;
    let previousSurface: SurfaceItem[] | undefined;
    let previousFactEvaluations: FactEvaluation[] = [];
    let outstandingObsolete: ObsoleteFactTarget[] = [];

    for (let index = 0; index < checkpoints.length; index += 1) {
      const checkpoint = checkpoints[index];
      const command = index === 0 ? "init" : "update";
      reportProgress({
        type: "checkpoint-start",
        checkpointId: checkpoint.id,
        checkpointIndex: index,
        totalCheckpoints: checkpoints.length,
        commit: checkpoint.commit,
        label: checkpoint.label,
        command,
        evaluationOnly: true,
      });

      const artifact = await loadSavedArtifact(sourceRunDir, checkpoint.id);
      const evidence = await loadSavedEvidence(sourceRunDir, checkpoint.id);
      await inputs.onArtifact?.(artifact);
      await inputs.onEvidence?.(evidence);
      reportProgress({
        type: "artifact-captured",
        checkpointId: checkpoint.id,
        documentCount: artifact.documents.length,
        loaded: true,
      });

      const surface = await extractSurface(
        inputs.benchmark.sourceRepoPath,
        checkpoint.commit,
      );
      let transitions: CheckpointTransitions | undefined;
      let newlyObsolete: ObsoleteFactTarget[] = [];

      if (
        index > 0 &&
        previousCheckpointId !== undefined &&
        previousSurface !== undefined
      ) {
        transitions = diffSurface(
          previousSurface,
          surface,
          previousCheckpointId,
          checkpoint.id,
        );
        newlyObsolete = obsoleteTargetsFor(transitions);
      }

      const obsoleteFacts = advanceObsoleteWatchSet({
        outstanding: outstandingObsolete,
        surface,
        newlyObsolete,
      });

      reportProgress({
        type: "evaluation-start",
        checkpointId: checkpoint.id,
        surfaceItemCount: surface.length,
        obsoleteFactCount: obsoleteFacts.length,
      });
      const evaluation = await inputs.evaluationBackend.evaluate({
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
          previousFactEvaluations,
        );
      }

      const original = savedCheckpoint(savedResult, checkpoint.id);
      scores.push({
        checkpointId: checkpoint.id,
        coverage,
        precision,
        evaluationCompleteness,
        maintenanceCounts,
        efficiency: {
          ...original.efficiency,
          churnedLines: computeChurn(previousArtifact, artifact),
        },
        evaluations: {
          factEvaluations: evaluation.factEvaluations,
          precisionEvaluations: evaluation.precisionEvaluations,
          forgettingEvaluations: evaluation.forgettingEvaluations,
          warnings: evaluation.warnings ?? [],
        },
      });
      history.push({
        checkpointId: checkpoint.id,
        factEvaluations: evaluation.factEvaluations,
        forgettingEvaluations: evaluation.forgettingEvaluations,
        transitions,
      });

      outstandingObsolete = obsoleteFacts;
      previousArtifact = artifact;
      previousCheckpointId = checkpoint.id;
      previousSurface = surface;
      previousFactEvaluations = evaluation.factEvaluations;
    }

    const result: LedgerRunResult = {
      metadata: {
        benchmarkName: inputs.benchmark.name,
        difficulty: inputs.benchmark.difficulty,
        startedAt: inputs.startedAt,
        system: savedResult.metadata.system,
        evaluatorModelId: inputs.evaluatorModelId,
        reevaluatedFrom: sourceRunDir,
      },
      checkpoints: scores,
      score: aggregateScore(scores),
      diagnostics: computeDiagnostics(history),
    };

    reportProgress({ type: "run-complete" });

    return result;
  } catch (error) {
    reportProgress({
      type: "run-failed",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
