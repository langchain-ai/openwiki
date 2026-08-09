import { SystemRunError } from "../core/errors.js";
import { captureArtifact } from "../replay/artifact.js";
import { computeChurn } from "../scoring/churn.js";
import { GitReplay } from "../replay/git-replay.js";
import {
  aggregateScore,
  computeCoverage,
  computeDiagnostics,
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
  EvaluationBackend,
  FactEvaluation,
  KebBenchmark,
  KebRunConfig,
  KebRunResult,
  KnowledgeArtifact,
  MaintenanceCounts,
  ObsoleteFactTarget,
  SystemRunOutcome,
  SystemUnderTest,
} from "../core/types.js";
import { createWorkspace } from "../replay/workspace.js";

/**
 * Everything the runner needs beyond the benchmark: the system to score, the
 * evaluator, the resolved config, and an injected start timestamp (injected so
 * the run result is deterministic in tests).
 */
export interface RunnerInputs {
  /**
   * The benchmark to run.
   */
  benchmark: KebBenchmark;

  /**
   * The system under test.
   */
  system: SystemUnderTest;

  /**
   * The evaluation backend.
   */
  evaluationBackend: EvaluationBackend;

  /**
   * The resolved run config.
   */
  config: KebRunConfig;

  /**
   * ISO-8601 start timestamp, injected by the caller.
   */
  startedAt: string;
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
 * ledger revives that knowledge (the fact is active again with the version's own
 * statement). KEB does not treat forgetting as permanent, so a version already
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
): Promise<KebRunResult> {
  const { benchmark, system, evaluationBackend, config, startedAt } = inputs;
  const checkpoints = benchmark.trace.checkpoints;
  const workspace = await createWorkspace();

  let replay: GitReplay | undefined;

  try {
    replay = await GitReplay.create(
      benchmark.sourceRepoPath,
      workspace.worktreeParent,
      checkpoints[0].commit,
    );

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

    for (let i = 0; i < checkpoints.length; i += 1) {
      const checkpoint = checkpoints[i];

      if (i > 0) {
        await replay.checkout(checkpoint.commit);
      }

      const outcome: SystemRunOutcome =
        i === 0
          ? await system.init(replay.worktreeDir)
          : await system.update(replay.worktreeDir);

      const artifact = await captureArtifact(
        checkpoint.id,
        replay.worktreeDir,
        workspace.artifactsRoot,
      );

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

      const evaluation = await evaluationBackend.evaluate({
        artifact,
        activeFacts,
        obsoleteFacts,
      });

      const coverage = computeCoverage(evaluation.factEvaluations);
      const precision = computePrecision(evaluation.precisionEvaluations);

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
        maintenanceCounts,
        efficiency: {
          durationMs: outcome.durationMs,
          skipped: outcome.skipped,
          churnedLines: computeChurn(previousArtifact, artifact),
          totalTokens: outcome.totalTokens,
        },
        // Retain the raw verdicts, not just their reduced counts, so a score is
        // explainable: the unsupported precision assertions are the candidate
        // missing ledger facts (or hallucinations), and the forgetting verdicts
        // make an otherwise invisible pass visible in the persisted result.
        evaluations: {
          factEvaluations: evaluation.factEvaluations,
          precisionEvaluations: evaluation.precisionEvaluations,
          forgettingEvaluations: evaluation.forgettingEvaluations,
        },
      });

      history.push({
        checkpointId: checkpoint.id,
        factEvaluations: evaluation.factEvaluations,
        forgettingEvaluations: evaluation.forgettingEvaluations,
        transitions,
      });

      // Keep every obsolete version under watch, including ones just judged
      // forgotten: KEB does not treat forgetting as permanent, so a version stays
      // in the forgetting pass until the ledger revives it (the revival filter
      // above is the only way a target leaves the watch set).
      outstandingObsolete = obsoleteFacts;

      previousArtifact = artifact;
      previousCheckpointId = checkpoint.id;
      previousFactEvaluations = evaluation.factEvaluations;
    }

    return {
      metadata: {
        benchmarkName: benchmark.name,
        startedAt,
        system: { provider: config.provider, modelId: config.systemModelId },
        evaluatorModelId: config.evaluatorModelId,
        evaluatorPromptVersion: evaluationBackend.version,
      },
      checkpoints: scores,
      score: aggregateScore(scores),
      diagnostics: computeDiagnostics(history),
    };
  } finally {
    await replay?.teardown();
    await workspace.dispose();
  }
}
