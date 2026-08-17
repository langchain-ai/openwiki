import { SystemRunError } from "../core/errors.js";
import { captureArtifact } from "../replay/artifact.js";
import { GitReplay } from "../replay/git-replay.js";
import { computeDiagnostics } from "../metrics/claims.js";
import { computeLedgerScore } from "../metrics/score.js";
import type {
  CheckpointEvaluationRecord,
  CheckpointResult,
  EvidenceCorpus,
  EvaluationBackend,
  LedgerBenchmark,
  LedgerRunConfig,
  LedgerRunResult,
  KnowledgeArtifact,
  SystemRunOutcome,
  SystemUnderTest,
} from "../core/types.js";
import { createWorkspace } from "../replay/workspace.js";
import {
  GitSourceEvidenceAdapter,
  type SourceEvidenceAdapter,
} from "../source/source-adapter.js";
import { evaluateCheckpoint, initialCarry } from "./evaluate-checkpoint.js";
import type { BenchmarkProgressReporter } from "./progress-events.js";

/**
 * Everything the runner needs beyond the benchmark: the system to evaluate, the
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
 * Run a benchmark end to end and return the measured result. Creates an isolated
 * workspace and a guarded Git replay, validates the whole trace up front, then
 * walks it running `init` then `update`, freezes an immutable artifact at each
 * checkpoint and evaluates it. The workspace and worktree
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
 * a forgetting-pass evaluation per watched version per checkpoint.
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

    const checkpointResults: CheckpointResult[] = [];
    const history: CheckpointEvaluationRecord[] = [];
    let carry = initialCarry();
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

      const {
        checkpointResult,
        history: historyEntry,
        nextCarry,
      } = await evaluateCheckpoint({
        sourceRepoPath: benchmark.sourceRepoPath,
        checkpoint,
        index: i,
        artifact,
        evidence,
        evidenceMap: benchmark.evidenceMap,
        evaluationBackend,
        carry,
        efficiency: {
          durationMs: outcome.durationMs,
          skipped: outcome.skipped,
        },
        reportProgress,
      });

      checkpointResults.push(checkpointResult);
      history.push(historyEntry);
      carry = nextCarry;
    }

    const result: LedgerRunResult = {
      metadata: {
        benchmarkName: benchmark.name,
        difficulty: benchmark.difficulty,
        startedAt,
        system: { provider: config.provider, modelId: config.systemModelId },
        evaluatorModelId: config.evaluatorModelId,
      },
      checkpoints: checkpointResults,
      score: computeLedgerScore(checkpointResults),
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
