import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadBenchmark } from "../../benchmark/benchmark.js";
import {
  computeTransitions,
  obsoleteTargetsFor,
} from "../../benchmark/transitions.js";
import { getActiveFacts } from "../../benchmark/truth-ledger.js";
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

type DefectKind =
  "invented" | "stale" | "coverage-gap" | "spurious-deletion" | "padding";

interface DefectDefinition {
  id: string;
  kind: DefectKind;
  checkpointId: string;
  operation: "append" | "delete";
  text: string;
  expectedClaim?: string;
  expectedFactId?: string;
}

interface DefectManifest {
  benchmark: string;
  defects: DefectDefinition[];
}

export interface DefectOutcome {
  id: string;
  kind: DefectKind;
  passed: boolean;
  message: string;
}

export interface DefectHarnessReport {
  cleanInventedCount: number;
  defects: DefectOutcome[];
  passed: boolean;
}

function dedupeTargets(targets: ObsoleteFactTarget[]): ObsoleteFactTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    if (seen.has(target.factVersionId)) return false;
    seen.add(target.factVersionId);
    return true;
  });
}

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

async function evaluateTrace(inputs: {
  benchmark: LedgerBenchmark;
  backend: EvaluationBackend;
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
      const activeFacts = getActiveFacts(inputs.benchmark, checkpoint.id);
      const transitions =
        previousCheckpointId === undefined
          ? undefined
          : computeTransitions(
              inputs.benchmark,
              previousCheckpointId,
              checkpoint.id,
            );
      const newlyObsolete =
        transitions === undefined ? [] : obsoleteTargetsFor(transitions);
      const activeById = new Map(
        activeFacts.map((fact) => [fact.factId, fact.statement]),
      );
      const obsoleteFacts = dedupeTargets([
        ...outstandingObsolete.filter(
          (fact) => activeById.get(fact.factId) !== fact.obsoleteStatement,
        ),
        ...newlyObsolete,
      ]);
      const artifact = await baseArtifact(
        checkpoint.id,
        inputs.defect?.checkpointId === checkpoint.id
          ? inputs.defect
          : undefined,
      );
      const evaluation = await inputs.backend.evaluate({
        artifact,
        activeFacts,
        evidence,
        obsoleteFacts,
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

function checkpoint(result: LedgerRunResult, id: string): CheckpointScore {
  const value = result.checkpoints.find((item) => item.checkpointId === id);
  if (value === undefined)
    throw new EvaluationError(`Missing checkpoint ${id}.`);
  return value;
}

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

/** Evaluate the clean captured trace and every seeded measurement defect. */
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
