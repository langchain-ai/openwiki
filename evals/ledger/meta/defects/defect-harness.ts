import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadBenchmark } from "../../benchmark/benchmark.js";
import {
  advanceObsoleteWatchSet,
  diffSurface,
  extractSurface,
  obsoleteTargetsFor,
} from "../../benchmark/surface.js";
import { EvaluationError } from "../../core/errors.js";
import type {
  CheckpointEvaluationRecord,
  CheckpointScore,
  EvaluationBackend,
  EvidenceCorpus,
  FactEvaluation,
  LedgerBenchmark,
  LedgerRunResult,
  KnowledgeArtifact,
  ObsoleteFactTarget,
  SurfaceItem,
} from "../../core/types.js";
import { GitReplay } from "../../replay/git-replay.js";
import { createWorkspace } from "../../replay/workspace.js";
import {
  aggregateScore,
  computeCoverage,
  computeDiagnostics,
  computeEvaluationCompleteness,
  computeMaintenanceCounts,
  computePrecision,
} from "../../scoring/metrics.js";
import { collectGitEvidence } from "../../source/git-evidence.js";

/**
 * The measurement failure a seeded defect is designed to provoke, and therefore
 * the precision or coverage class the evaluator must place it in to kill it.
 */
type DefectKind =
  "invented" | "stale" | "coverage-gap" | "spurious-deletion" | "padding";

/**
 * One seeded defect: a mutation to apply and the verdict it must produce.
 */
interface DefectDefinition {
  /**
   * Stable identifier used in the manifest and outcome messages.
   */
  id: string;

  /**
   * Measurement class the mutation is expected to be caught in.
   */
  kind: DefectKind;

  /**
   * Checkpoint whose base fixture the mutation is applied to.
   */
  checkpointId: string;

  /**
   * Whether the mutation appends `text` to the fixture or deletes it.
   */
  operation: "append" | "delete";

  /**
   * Literal text appended to or deleted from the base fixture.
   */
  text: string;

  /**
   * Claim the evaluator must classify to kill the defect.
   *
   * @default undefined for kinds keyed on a fact rather than a claim (coverage-gap, spurious-deletion)
   */
  expectedClaim?: string;

  /**
   * Fact the evaluator must report missing to kill the defect.
   *
   * @default undefined for kinds keyed on a claim rather than a fact
   */
  expectedFactId?: string;
}

/**
 * A defect manifest: the benchmark to replay and the defects to seed into it.
 */
interface DefectManifest {
  /**
   * Path to the benchmark, relative to the manifest file.
   */
  benchmark: string;

  /**
   * Every defect the harness seeds and assesses.
   */
  defects: DefectDefinition[];
}

/**
 * The result of seeding and assessing one defect.
 */
export interface DefectOutcome {
  /**
   * Identifier of the assessed defect.
   */
  id: string;

  /**
   * Measurement class the defect was expected to be caught in.
   */
  kind: DefectKind;

  /**
   * Whether the evaluator caught the defect in its expected class.
   */
  passed: boolean;

  /**
   * Human-readable outcome description.
   */
  message: string;
}

/**
 * The full report across the clean baseline and every seeded defect.
 */
export interface DefectHarnessReport {
  /**
   * Invented claims found in the unmutated baseline; must be zero to pass.
   */
  cleanInventedCount: number;

  /**
   * Per-defect outcomes, in manifest order.
   */
  defects: DefectOutcome[];

  /**
   * Whether the baseline was clean and every defect was caught.
   */
  passed: boolean;
}

/**
 * Apply a defect's mutation to base fixture content, or return it unchanged when
 * no defect targets this checkpoint. An append adds the defect text as a new list
 * item; a delete removes the first occurrence of the literal text.
 *
 * @param content - The base fixture content.
 * @param defect - The defect to apply, or undefined for the clean baseline.
 *
 * @returns The mutated (or unchanged) content.
 *
 * @throws EvaluationError when a delete defect's target text is absent.
 */
function mutate(content: string, defect: DefectDefinition | undefined): string {
  if (defect === undefined) return content;
  if (defect.operation === "append") {
    return `${content.trimEnd()}\n- ${defect.text}\n`;
  }
  if (!content.includes(defect.text)) {
    throw new EvaluationError(
      `Defect ${defect.id} could not delete its target fixture text.`,
    );
  }
  return content.replace(defect.text, "");
}

/**
 * Build the immutable knowledge artifact for a checkpoint from its committed
 * base fixture, applying a defect mutation when one targets this checkpoint. The
 * fixture stands in for a real system run so the harness measures the evaluator
 * alone, deterministically.
 *
 * @param checkpointId - Checkpoint whose base fixture to load.
 * @param defect - The defect to apply, or undefined for the clean baseline.
 *
 * @returns The single-document artifact for the checkpoint.
 */
async function baseArtifact(
  checkpointId: string,
  defect: DefectDefinition | undefined,
): Promise<KnowledgeArtifact> {
  const fixtureUrl = new URL(
    `./fixtures/base/${checkpointId}.md`,
    import.meta.url,
  );
  const content = mutate(await readFile(fixtureUrl, "utf8"), defect);
  return {
    checkpointId,
    snapshotDir: path.dirname(fileURLToPath(fixtureUrl)),
    fingerprint: `${checkpointId}:${defect?.id ?? "clean"}`,
    documents: [{ relativePath: "ledger.md", content }],
  };
}

/**
 * Replay a benchmark's whole trace against fixture artifacts and score it, with
 * an optional defect seeded into one checkpoint. Mirrors the production runner's
 * per-checkpoint scoring, forgetting watch set, and aggregation, but substitutes
 * committed fixtures for a live system run so the result reflects only the
 * evaluator's judgments.
 *
 * @param inputs - The benchmark, evaluation backend, and optional seeded defect.
 *
 * @returns The scored run result for the (possibly mutated) trace.
 */
async function evaluateTrace(inputs: {
  /**
   * Benchmark whose trace and requirements drive the evaluation.
   */
  benchmark: LedgerBenchmark;

  /**
   * Evaluation backend applied at each checkpoint.
   */
  backend: EvaluationBackend;

  /**
   * Defect to seed into its target checkpoint.
   *
   * @default undefined the clean baseline trace
   */
  defect?: DefectDefinition;
}): Promise<LedgerRunResult> {
  const workspace = await createWorkspace();
  let replay: GitReplay | undefined;
  try {
    const checkpoints = inputs.benchmark.trace.checkpoints;
    replay = await GitReplay.create(
      inputs.benchmark.sourceRepoPath,
      workspace.worktreeParent,
      checkpoints[0].commit,
    );
    const scores: CheckpointScore[] = [];
    const history: CheckpointEvaluationRecord[] = [];
    const evidenceHistory: EvidenceCorpus[] = [];
    let previousCheckpointId: string | undefined;
    let previousSurface: SurfaceItem[] | undefined;
    let previousFacts: FactEvaluation[] = [];
    let outstandingObsolete: ObsoleteFactTarget[] = [];

    for (const [index, checkpoint] of checkpoints.entries()) {
      if (index > 0) await replay.checkout(checkpoint.commit);
      const currentEvidence = await collectGitEvidence(
        checkpoint.id,
        replay.worktreeDir,
      );
      const evidence: EvidenceCorpus = {
        checkpointId: checkpoint.id,
        records: [
          ...currentEvidence.records,
          ...evidenceHistory.flatMap((historical) =>
            historical.records.map((record) => ({
              ...record,
              evidenceId: `${historical.checkpointId}:${record.evidenceId}`,
              current: false,
            })),
          ),
        ],
      };
      evidenceHistory.push(currentEvidence);
      const surface = await extractSurface(
        inputs.benchmark.sourceRepoPath,
        checkpoint.commit,
      );
      const transitions =
        previousCheckpointId === undefined || previousSurface === undefined
          ? undefined
          : diffSurface(
              previousSurface,
              surface,
              previousCheckpointId,
              checkpoint.id,
            );
      const newlyObsolete =
        transitions === undefined ? [] : obsoleteTargetsFor(transitions);
      const obsoleteFacts = advanceObsoleteWatchSet({
        outstanding: outstandingObsolete,
        surface,
        newlyObsolete,
      });
      const artifact = await baseArtifact(
        checkpoint.id,
        inputs.defect?.checkpointId === checkpoint.id
          ? inputs.defect
          : undefined,
      );
      const evaluation = await inputs.backend.evaluate({
        artifact,
        surface,
        evidence,
        obsoleteFacts,
        transitions,
      });
      const coverage = computeCoverage(evaluation.factEvaluations);
      const precision = computePrecision(evaluation.precisionEvaluations);
      const maintenanceCounts =
        transitions === undefined
          ? undefined
          : computeMaintenanceCounts(
              transitions,
              evaluation.factEvaluations,
              evaluation.forgettingEvaluations,
              previousFacts,
            );
      scores.push({
        checkpointId: checkpoint.id,
        coverage,
        precision,
        evaluationCompleteness: computeEvaluationCompleteness(
          evaluation.factEvaluations,
          evaluation.precisionEvaluations,
          evaluation.forgettingEvaluations,
        ),
        maintenanceCounts,
        efficiency: { durationMs: 0, skipped: true },
        evaluations: {
          ...evaluation,
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
      previousCheckpointId = checkpoint.id;
      previousSurface = surface;
      previousFacts = evaluation.factEvaluations;
    }

    return {
      metadata: {
        benchmarkName: inputs.benchmark.name,
        startedAt: "meta-defect-harness",
        system: { provider: "fixture" },
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

/**
 * Look up one checkpoint's score in a run result by id.
 *
 * @param result - The run result to search.
 * @param id - The checkpoint id to resolve.
 *
 * @returns The matching checkpoint score.
 *
 * @throws EvaluationError when the result has no such checkpoint.
 */
function checkpoint(result: LedgerRunResult, id: string): CheckpointScore {
  const value = result.checkpoints.find((item) => item.checkpointId === id);
  if (value === undefined)
    throw new EvaluationError(`Missing checkpoint ${id}.`);
  return value;
}

/**
 * Decide whether a seeded defect was caught in its expected measurement class.
 * Invented and stale defects require exactly one matching claim verdict; a
 * coverage gap requires the target fact reported missing; a spurious deletion
 * requires stable retention to drop below full; a padding defect requires the
 * added claim to land as unverified while every score that must stay put
 * (precision, hallucination, coverage) is unchanged from the clean baseline.
 *
 * @param definition - The seeded defect and its expectation.
 * @param baseline - The clean-trace run result, for baseline comparisons.
 * @param mutated - The run result with the defect seeded in.
 *
 * @returns The pass or fail outcome for the defect.
 */
function assessDefect(
  definition: DefectDefinition,
  baseline: LedgerRunResult,
  mutated: LedgerRunResult,
): DefectOutcome {
  const target = checkpoint(mutated, definition.checkpointId);
  const claims = target.evaluations?.precisionEvaluations ?? [];
  let passed = false;

  if (definition.kind === "invented" || definition.kind === "stale") {
    const matches = claims.filter(
      (claim) =>
        claim.assertion === definition.expectedClaim &&
        claim.verdict === definition.kind,
    );
    passed = matches.length === 1;
  } else if (definition.kind === "coverage-gap") {
    passed =
      target.evaluations?.factEvaluations.some(
        (fact) =>
          fact.factId === definition.expectedFactId &&
          fact.verdict === "missing",
      ) ?? false;
  } else if (definition.kind === "spurious-deletion") {
    const retention = target.maintenanceCounts?.stableRetention;
    passed =
      retention !== undefined && retention.numerator < retention.denominator;
  } else {
    const clean = checkpoint(baseline, definition.checkpointId);
    passed =
      claims.some(
        (claim) =>
          claim.assertion === definition.expectedClaim &&
          claim.verdict === "unverified",
      ) &&
      target.precision.unverifiedRate > clean.precision.unverifiedRate &&
      target.precision.score === clean.precision.score &&
      target.precision.hallucinationRate ===
        clean.precision.hallucinationRate &&
      target.coverage.score === clean.coverage.score;
  }

  return {
    id: definition.id,
    kind: definition.kind,
    passed,
    message: passed
      ? `${definition.id} killed as ${definition.kind}.`
      : `${definition.id} was not detected in the expected ${definition.kind} class.`,
  };
}

/**
 * Evaluate the clean captured trace and every seeded measurement defect.
 */
export async function runDefectHarness(inputs: {
  backend: EvaluationBackend;
  manifestUrl?: URL;
}): Promise<DefectHarnessReport> {
  const manifestUrl =
    inputs.manifestUrl ?? new URL("./fixtures/manifest.json", import.meta.url);
  const manifest = JSON.parse(
    await readFile(manifestUrl, "utf8"),
  ) as DefectManifest;
  const benchmark = await loadBenchmark(
    path.resolve(path.dirname(fileURLToPath(manifestUrl)), manifest.benchmark),
  );
  const baseline = await evaluateTrace({ benchmark, backend: inputs.backend });
  const cleanInventedCount = baseline.checkpoints.reduce(
    (total, item) => total + item.precision.invented,
    0,
  );
  const defects: DefectOutcome[] = [];
  for (const definition of manifest.defects) {
    const mutated = await evaluateTrace({
      benchmark,
      backend: inputs.backend,
      defect: definition,
    });
    defects.push(assessDefect(definition, baseline, mutated));
  }

  return {
    cleanInventedCount,
    defects,
    passed:
      cleanInventedCount === 0 && defects.every((defect) => defect.passed),
  };
}
