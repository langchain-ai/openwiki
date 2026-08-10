import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type {
  CheckpointEvaluation,
  CheckpointScore,
  EvaluationBackend,
  EvaluationInput,
  EvidenceCorpus,
  LedgerBenchmark,
  LedgerRunResult,
  KnowledgeArtifact,
} from "../core/types.js";
import { createTinyRepo, type TinyRepo } from "../testing/tiny-repo.js";
import {
  prepareRunDirectory,
  writeArtifactSnapshot,
  writeEvidenceCorpus,
  writeRunResult,
} from "./persistence.js";
import { reevaluateSavedRun } from "./reevaluator.js";

/**
 * Deterministic evaluator that marks every active requirement correct, every
 * obsolete version forgotten, and one artifact assertion source-supported.
 */
class SavedInputEvaluator implements EvaluationBackend {
  readonly seenArtifacts: string[] = [];

  /**
   * Evaluate one checkpoint and record that its persisted artifact was loaded.
   *
   * @param input - Reconstructed saved evaluation input.
   *
   * @returns Deterministic complete judgments.
   */
  async evaluate(input: EvaluationInput): Promise<CheckpointEvaluation> {
    this.seenArtifacts.push(input.artifact.documents[0]?.content ?? "");

    return {
      factEvaluations: input.surface.map((fact) => ({
        factId: fact.factId,
        factVersionId: fact.factVersionId,
        verdict: "correct",
        evidence: ["page.md::0000"],
        rationale: "The saved artifact states the surface item.",
      })),
      forgettingEvaluations: input.obsoleteFacts.map((fact) => ({
        factId: fact.factId,
        factVersionId: fact.factVersionId,
        verdict: "forgotten",
        evidence: [],
        rationale: "The saved artifact omits the obsolete statement.",
      })),
      precisionEvaluations: [
        {
          assertion: "The saved artifact is grounded.",
          location: "page.md",
          verdict: "supported",
          tense: "current",
          adjudicatedBy: "source",
          evidenceIds: ["source::0000"],
          rationale: "The saved source evidence supports it.",
        },
      ],
    };
  }
}

/**
 * Build the two-checkpoint benchmark used by evaluator-only replay tests. The
 * source repo evolves one exported symbol's signature at T1 so the surface diff
 * yields exactly one changed element and thus one maintenance correction
 * boundary.
 *
 * @param repo - Tiny repository supplying the two checkpoint commits.
 *
 * @returns A source-grounded benchmark trace.
 */
function benchmark(repo: TinyRepo): LedgerBenchmark {
  return {
    name: "saved-evolution",
    description: "saved replay test",
    sourceRepoPath: repo.repoPath,
    trace: {
      checkpoints: [
        { id: "T0", commit: repo.shas[0], label: "version one" },
        { id: "T1", commit: repo.shas[1], label: "version two" },
      ],
    },
  };
}

/**
 * Build an original checkpoint containing only execution observations that
 * evaluator replay must preserve.
 *
 * @param checkpointId - Checkpoint identity.
 * @param durationMs - Original system duration.
 *
 * @returns A minimal checkpoint score.
 */
function originalCheckpoint(
  checkpointId: string,
  durationMs: number,
): CheckpointScore {
  return {
    checkpointId,
    coverage: {
      correct: 0,
      partial: 0,
      missing: 0,
      contradicted: 0,
      indeterminate: 0,
      total: 0,
      score: 0,
    },
    precision: {
      supported: 0,
      invented: 0,
      stale: 0,
      unverified: 0,
      adjudicated: 0,
      total: 0,
      hallucinationRate: null,
      stalenessRate: null,
      unverifiedRate: 0,
      score: null,
    },
    evaluationCompleteness: { judged: 0, indeterminate: 0, total: 0, score: 1 },
    efficiency: { durationMs, skipped: false },
  };
}

/**
 * Build the completed source result supplying original run metadata and
 * efficiency observations.
 *
 * @returns A complete source-run result.
 */
function sourceResult(): LedgerRunResult {
  return {
    metadata: {
      benchmarkName: "saved-evolution",
      startedAt: "2026-01-01T00:00:00.000Z",
      system: { provider: "anthropic", modelId: "system-model" },
      evaluatorModelId: "old-evaluator",
    },
    checkpoints: [
      originalCheckpoint("T0", 10_000),
      originalCheckpoint("T1", 5_000),
    ],
    score: {
      traceCoverage: 0,
      tracePrecision: null,
      traceHallucinationRate: null,
      traceStalenessRate: null,
      traceUnverifiedRate: 0,
      evaluationCompleteness: 1,
      quality: null,
      maintenanceRates: {},
      ledgerScore: null,
    },
    diagnostics: {
      recovery: { recovered: 0, eligible: 0 },
      staleKnowledge: { records: [], unresolvedCount: 0 },
    },
  };
}

/**
 * Build a saved wiki artifact for one checkpoint.
 *
 * @param checkpointId - Checkpoint identity.
 * @param content - Wiki text captured at the checkpoint.
 *
 * @returns A persistable knowledge artifact.
 */
function artifact(checkpointId: string, content: string): KnowledgeArtifact {
  return {
    checkpointId,
    snapshotDir: "/unused",
    fingerprint: checkpointId,
    documents: [{ relativePath: "page.md", content }],
  };
}

/**
 * Build saved source evidence for one checkpoint.
 *
 * @param checkpointId - Checkpoint identity.
 *
 * @returns A one-record source corpus.
 */
function evidence(checkpointId: string): EvidenceCorpus {
  return {
    checkpointId,
    records: [
      {
        evidenceId: "source::0000",
        sourceRef: "src/version.ts",
        observedAtCheckpoint: checkpointId,
        current: true,
        content: `export const VERSION = "${checkpointId}";`,
      },
    ],
  };
}

describe("reevaluateSavedRun", () => {
  const temporaryDirectories: string[] = [];
  let repo: TinyRepo;

  beforeEach(async () => {
    repo = await createTinyRepo([
      {
        message: "T0",
        files: { "code.ts": "export function f(): number {\n  return 1;\n}\n" },
      },
      {
        message: "T1",
        files: {
          "code.ts": "export function f(a: number): number {\n  return a;\n}\n",
        },
      },
    ]);
  });

  afterEach(async () => {
    await repo.dispose();
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  test("recomputes semantic and longitudinal scores without invoking a system", async () => {
    const resultsDir = await mkdtemp(path.join(os.tmpdir(), "ledger-reeval-"));
    temporaryDirectories.push(resultsDir);
    const original = sourceResult();
    const runDir = await prepareRunDirectory(
      resultsDir,
      original.metadata.benchmarkName,
      original.metadata.startedAt,
    );

    await writeArtifactSnapshot(runDir, artifact("T0", "Version is one.\n"));
    await writeArtifactSnapshot(runDir, artifact("T1", "Version is two.\n"));
    await writeEvidenceCorpus(runDir, evidence("T0"));
    await writeEvidenceCorpus(runDir, evidence("T1"));
    await writeRunResult(resultsDir, original);

    const evaluator = new SavedInputEvaluator();
    const events: string[] = [];
    const result = await reevaluateSavedRun({
      benchmark: benchmark(repo),
      sourceRunDir: runDir,
      evaluationBackend: evaluator,
      provider: "anthropic",
      evaluatorModelId: "new-evaluator",
      startedAt: "2026-01-02T00:00:00.000Z",
      onProgress: (event) => events.push(event.type),
    });

    expect(evaluator.seenArtifacts).toEqual([
      "Version is one.\n",
      "Version is two.\n",
    ]);
    expect(result.metadata).toMatchObject({
      system: { provider: "anthropic", modelId: "system-model" },
      evaluatorModelId: "new-evaluator",
      reevaluatedFrom: runDir,
    });
    expect(
      result.checkpoints.map((item) => item.efficiency.durationMs),
    ).toEqual([10_000, 5_000]);
    expect(result.score).toMatchObject({
      traceCoverage: 1,
      tracePrecision: 1,
      maintenance: 1,
      ledgerScore: 1,
    });
    expect(
      result.checkpoints[1].maintenanceCounts?.changedKnowledgeCorrection,
    ).toEqual({ numerator: 1, denominator: 1 });
    expect(events).toContain("run-complete");
    expect(events).not.toContain("system-complete");
  });
});
