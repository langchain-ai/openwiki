import { SystemRunError } from "../core/errors.js";
import { captureArtifact } from "../replay/artifact.js";
import { computeChurn } from "../scoring/churn.js";
import { GitReplay } from "../replay/git-replay.js";
import {
  aggregateScore,
  computeCoverage,
  computeDiagnostics,
  computeEvaluationCompleteness,
  computeMaintenanceCounts,
  computePrecision,
} from "../scoring/metrics.js";
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
  EvidenceCorpus,
  EvaluationBackend,
  FactEvaluation,
  LedgerBenchmark,
  LedgerRunConfig,
  LedgerRunResult,
  KnowledgeArtifact,
  MaintenanceCounts,
  ObsoleteFactTarget,
  SurfaceItem,
  SystemRunOutcome,
  SystemUnderTest,
} from "../core/types.js";
import { createWorkspace } from "../replay/workspace.js";
import {
  GitSourceEvidenceAdapter,
  type SourceEvidenceAdapter,
} from "../source/source-adapter.js";
import type { BenchmarkProgressReporter } from "./progress-events.js";

/**
 * Everything the runner needs beyond the benchmark: the system to score, the
 * evaluator, the resolved config, and an injected start timestamp (injected so
 * the run result is deterministic in tests).
 */
export interface RunnerInputs {
  /**
   * The benchmark to run.
   */
  benchmark: LedgerBenchmark;

  /**
   * The system under test.
   */
  system: SystemUnderTest;

  /**
   * The evaluation backend.
   */
  evaluationBackend: EvaluationBackend;

  /**
   * Adapter that normalizes the active source checkpoint into evidence.
   *
   * @default Git tracked-file evidence
   */
  sourceEvidenceAdapter?: SourceEvidenceAdapter;

  /**
   * Durable sink invoked after each artifact capture and before its evaluation
   * begins.
   *
   * @default undefined captured artifacts are not persisted
   */
  onArtifact?: (artifact: KnowledgeArtifact) => void | Promise<void>;

  /**
   * Durable sink invoked after checkpoint source evidence is collected and
   * before semantic evaluation begins.
   *
   * @default undefined collected evidence is not persisted
   */
  onEvidence?: (evidence: EvidenceCorpus) => void | Promise<void>;

  /**
   * The resolved run config.
   */
  config: LedgerRunConfig;

  /**
   * ISO-8601 start timestamp, injected by the caller.
   */
  startedAt: string;

  /**
   * Lifecycle observer used by interactive command-line output.
   *
   * @default undefined lifecycle events are discarded
   */
  onProgress?: BenchmarkProgressReporter;
}

/**
 * Run a benchmark end to end and return the scored result. Creates an isolated
 * workspace and a guarded Git replay, validates the whole trace up front, then
 * walks it running `init` then `update`, freezes an immutable artifact at each
 * checkpoint, evaluates it, and aggregates the scores. The workspace and worktree
 * are always torn down, even on failure.
 *
 * The preflight validation, before any system runs, checks three things for the
 * trace: every checkpoint SHA resolves to a commit in the source repo, every
 * checkpoint is a Git ancestor of the one that follows it, and no checkpoint
 * tracks anything under the wiki directory.
 *
 * Sticky obsolete targets: once a fact version goes obsolete it stays in the
 * forgetting watch set for every later checkpoint, and is retired only when the
 * requirements revive that knowledge (the fact is active again with the version's own
 * statement). LEDGER does not treat forgetting as permanent, so a version already
 * judged forgotten is still re-checked at later checkpoints; that is what lets the
 * Stale-Knowledge Lifetime diagnostic measure how long stale knowledge lingers and
 * keeps a later lingering regression visible in the forgetting history. This adds
 * a forgetting-pass evaluation per watched version per checkpoint but does not
 * affect the Maintenance Score, because `computeMaintenanceCounts` only ever
 * matches forgetting verdicts against the current boundary's own obsolete versions.
 *
 * @param inputs - The runner inputs.
 *
 * @returns The complete run result.
 *
 * @throws SystemRunError when the initial run produces no wiki.
 *
 * @throws GitReplayError when a checkpoint SHA does not resolve, a checkpoint is
 *   not an ancestor of the next, or a checkpoint tracks files under the wiki
 *   directory.
 */
export async function runBenchmark(
  inputs: RunnerInputs,
): Promise<LedgerRunResult> {
  const { benchmark, system, evaluationBackend, config, startedAt } = inputs;
  const sourceEvidenceAdapter =
    inputs.sourceEvidenceAdapter ?? new GitSourceEvidenceAdapter();
  const checkpoints = benchmark.trace.checkpoints;
  const reportProgress = inputs.onProgress ?? (() => undefined);
  reportProgress({
    type: "run-start",
    benchmarkName: benchmark.name,
    difficulty: benchmark.difficulty,
    totalCheckpoints: checkpoints.length,
    provider: config.provider,
    systemModelId: config.systemModelId,
    evaluatorModelId: config.evaluatorModelId,
  });
  const workspace = await createWorkspace();

  let replay: GitReplay | undefined;

  try {
    replay = await GitReplay.create(
      benchmark.sourceRepoPath,
      workspace.worktreeParent,
      checkpoints[0].commit,
    );
    reportProgress({ type: "replay-ready" });

    for (let i = 0; i < checkpoints.length; i += 1) {
      const checkpoint = checkpoints[i];

      await replay.assertCommitResolves(checkpoint.commit);

      if (i > 0) {
        await replay.assertAncestor(
          checkpoints[i - 1].commit,
          checkpoint.commit,
        );
      }

      await replay.assertWikiNotTrackedAt(checkpoint.commit);
    }

    const scores: CheckpointScore[] = [];
    const history: CheckpointEvaluationRecord[] = [];
    let previousArtifact: KnowledgeArtifact | undefined;
    let previousCheckpointId: string | undefined;
    let previousSurface: SurfaceItem[] | undefined;
    let previousFactEvaluations: FactEvaluation[] = [];
    let outstandingObsolete: ObsoleteFactTarget[] = [];
    const evidenceHistory: EvidenceCorpus[] = [];

    for (let i = 0; i < checkpoints.length; i += 1) {
      const checkpoint = checkpoints[i];
      const command = i === 0 ? "init" : "update";

      reportProgress({
        type: "checkpoint-start",
        checkpointId: checkpoint.id,
        checkpointIndex: i,
        totalCheckpoints: checkpoints.length,
        commit: checkpoint.commit,
        label: checkpoint.label,
        command,
      });

      if (i > 0) {
        await replay.checkout(checkpoint.commit);
      }

      const outcome: SystemRunOutcome =
        i === 0
          ? await system.init(replay.worktreeDir)
          : await system.update(replay.worktreeDir);
      reportProgress({
        type: "system-complete",
        checkpointId: checkpoint.id,
        command,
        durationMs: outcome.durationMs,
        skipped: outcome.skipped,
      });

      const artifact = await captureArtifact(
        checkpoint.id,
        replay.worktreeDir,
        workspace.artifactsRoot,
      );
      await inputs.onArtifact?.(artifact);
      const currentEvidence = await sourceEvidenceAdapter.collectEvidence(
        checkpoint.id,
        replay.worktreeDir,
      );
      const evidence: EvidenceCorpus = {
        checkpointId: checkpoint.id,
        records: [
          ...currentEvidence.records.map((record) => ({
            ...record,
            current: true,
          })),
          ...evidenceHistory.flatMap((historical) =>
            historical.records.map((record) => ({
              ...record,
              evidenceId: `${historical.checkpointId}:${record.evidenceId}`,
              current: false,
            })),
          ),
        ],
      };
      await inputs.onEvidence?.(evidence);
      evidenceHistory.push(currentEvidence);
      reportProgress({
        type: "artifact-captured",
        checkpointId: checkpoint.id,
        documentCount: artifact.documents.length,
      });

      if (i === 0 && artifact.documents.length === 0) {
        throw new SystemRunError(
          `System "${system.name}" produced no wiki at the initial checkpoint.`,
        );
      }

      const surface = await extractSurface(
        benchmark.sourceRepoPath,
        checkpoint.commit,
      );

      let transitions: CheckpointTransitions | undefined;
      let newlyObsolete: ObsoleteFactTarget[] = [];

      if (
        i > 0 &&
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
          previousFactEvaluations,
        );
      }

      scores.push({
        checkpointId: checkpoint.id,
        coverage,
        precision,
        evaluationCompleteness,
        maintenanceCounts,
        efficiency: {
          durationMs: outcome.durationMs,
          skipped: outcome.skipped,
          churnedLines: computeChurn(previousArtifact, artifact),
          totalTokens: outcome.totalTokens,
        },
        // Retain the raw verdicts, not just their reduced counts, so a score is
        // explainable: precision classes remain distinguishable,
        // and forgetting verdicts make an otherwise invisible pass visible in
        // the persisted result.
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

      // Keep every obsolete version under watch, including ones just judged
      // forgotten: LEDGER does not treat forgetting as permanent, so a version stays
      // in the forgetting pass until the requirements revive it (the revival filter
      // above is the only way a target leaves the watch set).
      outstandingObsolete = obsoleteFacts;

      previousArtifact = artifact;
      previousCheckpointId = checkpoint.id;
      previousSurface = surface;
      previousFactEvaluations = evaluation.factEvaluations;
    }

    const result: LedgerRunResult = {
      metadata: {
        benchmarkName: benchmark.name,
        difficulty: benchmark.difficulty,
        startedAt,
        system: { provider: config.provider, modelId: config.systemModelId },
        evaluatorModelId: config.evaluatorModelId,
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
  } finally {
    await replay?.teardown();
    await workspace.dispose();
  }
}
