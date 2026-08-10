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
  computeTransitions,
  obsoleteTargetsFor,
} from "../benchmark/transitions.js";
import { getActiveFacts } from "../benchmark/truth-ledger.js";
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
  SystemRunOutcome,
  SystemUnderTest,
} from "../core/types.js";
import { createWorkspace } from "../replay/workspace.js";
import {
  GitSourceEvidenceAdapter,
  type SourceEvidenceAdapter,
} from "../source/source-adapter.js";

/**
 * Observable lifecycle events emitted by a benchmark run.
 */
export type BenchmarkProgressEvent =
  | {
      type: "run-start";
      benchmarkName: string;
      totalCheckpoints: number;
      provider: string;
      systemModelId?: string;
      evaluatorModelId?: string;
      evaluationOnly?: boolean;
    }
  | { type: "replay-ready"; saved?: boolean }
  | {
      type: "checkpoint-start";
      checkpointId: string;
      checkpointIndex: number;
      totalCheckpoints: number;
      commit: string;
      label?: string;
      command: "init" | "update";
      evaluationOnly?: boolean;
    }
  | {
      type: "system-complete";
      checkpointId: string;
      command: "init" | "update";
      durationMs: number;
      skipped: boolean;
    }
  | {
      type: "artifact-captured";
      checkpointId: string;
      documentCount: number;
      loaded?: boolean;
    }
  | {
      type: "evaluation-start";
      checkpointId: string;
      activeFactCount: number;
      obsoleteFactCount: number;
    }
  | {
      type: "checkpoint-complete";
      checkpointId: string;
      coverageScore: number;
      precisionScore: number | null;
      hallucinationRate: number | null;
      stalenessRate: number | null;
      unverifiedRate: number;
      forgottenCount: number;
      obsoleteFactCount: number;
      evaluationCompleteness: number;
      indeterminateCount: number;
      evaluationItemCount: number;
      materialClaimCount: number;
      supportedCount: number;
      inventedCount: number;
      staleCount: number;
      unverifiedCount: number;
    }
  | {
      type: "run-complete";
      ledgerScore: number | null;
      quality: number | null;
      traceCoverage: number;
      tracePrecision: number | null;
      traceHallucinationRate: number | null;
      traceStalenessRate: number | null;
      traceUnverifiedRate: number;
      maintenance?: number;
      newKnowledgeDiscovery?: number;
      changedKnowledgeCorrection?: number;
      completeForgetting?: number;
      stableRetention?: number;
      evaluationCompleteness: number;
      materialClaimCount: number;
      supportedCount: number;
      inventedCount: number;
      staleCount: number;
      unverifiedCount: number;
    }
  | { type: "run-failed"; message: string };

/**
 * Receives one benchmark lifecycle event synchronously.
 */
export type BenchmarkProgressReporter = (event: BenchmarkProgressEvent) => void;

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
   * Optional durable sink invoked after each artifact capture and before its
   * evaluation begins.
   */
  onArtifact?: (artifact: KnowledgeArtifact) => void | Promise<void>;

  /**
   * Optional durable sink invoked after checkpoint source evidence is collected
   * and before semantic evaluation begins.
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
   * Optional lifecycle observer used by interactive command-line output.
   */
  onProgress?: BenchmarkProgressReporter;
}

/**
 * Deduplicate obsolete forgetting targets by `factVersionId`, keeping the first
 * occurrence. Sticky carry-forward concatenates the targets still outstanding
 * from earlier boundaries with the ones this boundary introduces; a version goes
 * obsolete at exactly one boundary, so this is a defensive guard rather than a
 * load-bearing merge, but it keeps the evaluator from ever seeing a version
 * twice in one checkpoint.
 *
 * @param targets - The obsolete targets to deduplicate.
 *
 * @returns The targets with duplicate versions removed, in first-seen order.
 */
function dedupeTargets(targets: ObsoleteFactTarget[]): ObsoleteFactTarget[] {
  const seen = new Set<string>();
  const result: ObsoleteFactTarget[] = [];

  for (const target of targets) {
    if (seen.has(target.factVersionId)) {
      continue;
    }

    seen.add(target.factVersionId);
    result.push(target);
  }

  return result;
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

      const activeFacts = getActiveFacts(benchmark, checkpoint.id);

      let transitions: CheckpointTransitions | undefined;
      let newlyObsolete: ObsoleteFactTarget[] = [];

      if (i > 0 && previousCheckpointId !== undefined) {
        transitions = computeTransitions(
          benchmark,
          previousCheckpointId,
          checkpoint.id,
        );
        newlyObsolete = obsoleteTargetsFor(transitions);
      }

      // Do not keep chasing an obsolete version once the same knowledge is true
      // again: if the fact id is active here with the exact canonical statement
      // the target calls obsolete, the knowledge has been revived, so retire the
      // stale target rather than asking the wiki to forget something true.
      const activeStatementByFactId = new Map(
        activeFacts.map((fact): [string, string] => [
          fact.factId,
          fact.statement,
        ]),
      );
      const carriedObsolete = outstandingObsolete.filter(
        (target) =>
          activeStatementByFactId.get(target.factId) !==
          target.obsoleteStatement,
      );

      // Carry the still-obsolete versions forward alongside this boundary's newly
      // obsolete ones so the forgetting pass keeps checking them; this is what
      // makes Stale-Knowledge Lifetime measurable. Maintenance is unaffected,
      // because computeMaintenanceCounts only ever matches the current boundary's
      // own obsolete versions.
      const obsoleteFacts = dedupeTargets([
        ...carriedObsolete,
        ...newlyObsolete,
      ]);

      reportProgress({
        type: "evaluation-start",
        checkpointId: checkpoint.id,
        activeFactCount: activeFacts.length,
        obsoleteFactCount: obsoleteFacts.length,
      });

      const evaluation = await evaluationBackend.evaluate({
        artifact,
        activeFacts,
        evidence,
        obsoleteFacts,
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
        stalenessRate: precision.stalenessRate,
        unverifiedRate: precision.unverifiedRate,
        forgottenCount: evaluation.forgettingEvaluations.filter(
          (item) => item.verdict === "forgotten",
        ).length,
        obsoleteFactCount: evaluation.forgettingEvaluations.length,
        evaluationCompleteness: evaluationCompleteness.score,
        indeterminateCount: evaluationCompleteness.indeterminate,
        evaluationItemCount: evaluationCompleteness.total,
        materialClaimCount: precision.total,
        supportedCount: precision.supported,
        inventedCount: precision.invented,
        staleCount: precision.stale,
        unverifiedCount: precision.unverified,
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
      previousFactEvaluations = evaluation.factEvaluations;
    }

    const result: LedgerRunResult = {
      metadata: {
        benchmarkName: benchmark.name,
        startedAt,
        system: { provider: config.provider, modelId: config.systemModelId },
        evaluatorModelId: config.evaluatorModelId,
      },
      checkpoints: scores,
      score: aggregateScore(scores),
      diagnostics: computeDiagnostics(history),
    };
    const precisionCounts = result.checkpoints.reduce(
      (counts, checkpoint) => ({
        supported: counts.supported + checkpoint.precision.supported,
        invented: counts.invented + checkpoint.precision.invented,
        stale: counts.stale + checkpoint.precision.stale,
        unverified: counts.unverified + checkpoint.precision.unverified,
      }),
      {
        supported: 0,
        invented: 0,
        stale: 0,
        unverified: 0,
      },
    );

    reportProgress({
      type: "run-complete",
      ledgerScore: result.score.ledgerScore,
      quality: result.score.quality,
      traceCoverage: result.score.traceCoverage,
      tracePrecision: result.score.tracePrecision,
      traceHallucinationRate: result.score.traceHallucinationRate,
      traceStalenessRate: result.score.traceStalenessRate,
      traceUnverifiedRate: result.score.traceUnverifiedRate,
      maintenance: result.score.maintenance,
      newKnowledgeDiscovery:
        result.score.maintenanceRates.newKnowledgeDiscovery,
      changedKnowledgeCorrection:
        result.score.maintenanceRates.changedKnowledgeCorrection,
      completeForgetting: result.score.maintenanceRates.completeForgetting,
      stableRetention: result.score.maintenanceRates.stableRetention,
      evaluationCompleteness: result.score.evaluationCompleteness,
      materialClaimCount: result.checkpoints.reduce(
        (total, checkpoint) => total + checkpoint.precision.total,
        0,
      ),
      supportedCount: precisionCounts.supported,
      inventedCount: precisionCounts.invented,
      staleCount: precisionCounts.stale,
      unverifiedCount: precisionCounts.unverified,
    });
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
