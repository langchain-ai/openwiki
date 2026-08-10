import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runBenchmark } from "./runner.js";
import type { BenchmarkProgressEvent } from "./progress-events.js";
import { createTinyRepo, type TinyRepo } from "../testing/tiny-repo.js";
import type {
  CheckpointEvaluation,
  EvaluationBackend,
  EvaluationInput,
  LedgerBenchmark,
  LedgerRunConfig,
  SystemRunOutcome,
  SystemUnderTest,
} from "../core/types.js";
import { wikiDirFor } from "../core/paths.js";

/**
 * A fake system that writes one deterministic wiki file per run. Content differs
 * between init and update so churn is non-zero at T1.
 */
class FakeSystem implements SystemUnderTest {
  readonly name = "fake-system";

  async init(worktreeDir: string): Promise<SystemRunOutcome> {
    await this.write(worktreeDir, "f1: A\nf2: x1\n");

    return { skipped: false, durationMs: 10 };
  }

  async update(worktreeDir: string): Promise<SystemRunOutcome> {
    await this.write(worktreeDir, "f1: A\nf2: x2\n");

    return { skipped: false, durationMs: 20 };
  }

  private async write(worktreeDir: string, body: string): Promise<void> {
    const file = path.join(wikiDirFor(worktreeDir), "page.md");

    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body, "utf8");
  }
}

/**
 * A fake evaluator returning canned verdicts keyed by checkpoint id, so the run
 * result is fully determined.
 */
class FakeEvaluator implements EvaluationBackend {
  async evaluate(input: EvaluationInput): Promise<CheckpointEvaluation> {
    if (input.artifact.checkpointId === "T0") {
      return {
        factEvaluations: [
          {
            factId: "f1",
            factVersionId: "f1@T0",
            verdict: "correct",
            evidence: [],
            rationale: "",
          },
          {
            factId: "f2",
            factVersionId: "f2@T0",
            verdict: "correct",
            evidence: [],
            rationale: "",
          },
        ],
        forgettingEvaluations: [],
        precisionEvaluations: [
          {
            assertion: "a",
            location: "page.md",
            verdict: "supported",
            tense: "current",
            adjudicatedBy: "ledger",
            evidenceIds: ["source::a"],
            rationale: "",
          },
          {
            assertion: "b",
            location: "page.md",
            verdict: "supported",
            tense: "current",
            adjudicatedBy: "ledger",
            evidenceIds: ["source::b"],
            rationale: "",
          },
        ],
      };
    }

    return {
      factEvaluations: [
        {
          factId: "f1",
          factVersionId: "f1@T0",
          verdict: "correct",
          evidence: [],
          rationale: "",
        },
        {
          factId: "f2",
          factVersionId: "f2@T1",
          verdict: "correct",
          evidence: [],
          rationale: "",
        },
      ],
      forgettingEvaluations: [
        {
          factId: "f2",
          factVersionId: "f2@T0",
          verdict: "forgotten",
          evidence: [],
          rationale: "",
        },
      ],
      precisionEvaluations: [
        {
          assertion: "a",
          location: "page.md",
          verdict: "supported",
          tense: "current",
          adjudicatedBy: "ledger",
          evidenceIds: ["source::a"],
          rationale: "",
        },
        {
          assertion: "b",
          location: "page.md",
          verdict: "invented",
          tense: "current",
          adjudicatedBy: "source",
          evidenceIds: ["source::b"],
          rationale: "",
        },
      ],
    };
  }
}

/**
 * An evaluator that records the forgetting watch set (the obsolete versions it is
 * asked about) at each checkpoint, and answers every active fact `correct` and
 * every obsolete target `forgotten`. It exists to assert what the runner carries
 * into the forgetting pass across checkpoints, not to produce a meaningful score.
 */
class RecordingEvaluator implements EvaluationBackend {
  readonly watchSets = new Map<string, string[]>();

  async evaluate(input: EvaluationInput): Promise<CheckpointEvaluation> {
    this.watchSets.set(
      input.artifact.checkpointId,
      input.obsoleteFacts.map((target) => target.factVersionId),
    );

    return {
      factEvaluations: input.activeFacts.map((fact) => ({
        factId: fact.factId,
        factVersionId: fact.factVersionId,
        verdict: "correct",
        evidence: [],
        rationale: "",
      })),
      forgettingEvaluations: input.obsoleteFacts.map((target) => ({
        factId: target.factId,
        factVersionId: target.factVersionId,
        verdict: "forgotten",
        evidence: [],
        rationale: "",
      })),
      precisionEvaluations: [],
    };
  }
}

describe("runBenchmark", () => {
  let repo: TinyRepo;

  beforeEach(async () => {
    repo = await createTinyRepo([
      { message: "c0", files: { "code.ts": "export const v = 1;\n" } },
      { message: "c1", files: { "code.ts": "export const v = 2;\n" } },
    ]);
  });

  afterEach(async () => {
    await repo.dispose();
  });

  function benchmark(): LedgerBenchmark {
    return {
      name: "fake",
      description: "deterministic end-to-end",
      sourceRepoPath: repo.repoPath,
      trace: {
        checkpoints: [
          { id: "T0", commit: repo.shas[0] },
          { id: "T1", commit: repo.shas[1] },
        ],
      },
      truthPackage: {
        requirements: [
          { id: "f1", versions: [{ statement: "A", fromCheckpoint: "T0" }] },
          {
            id: "f2",
            versions: [
              { statement: "x1", fromCheckpoint: "T0", untilCheckpoint: "T1" },
              { statement: "x2", fromCheckpoint: "T1" },
            ],
          },
        ],
      },
    };
  }

  function config(): LedgerRunConfig {
    return {
      benchmarkDir: "/nonexistent",
      provider: "fake-provider",
      resultsDir: "/nonexistent",
    };
  }

  test("produces the exact hand-computed LEDGER score", async () => {
    const progress: BenchmarkProgressEvent[] = [];
    const result = await runBenchmark({
      benchmark: benchmark(),
      system: new FakeSystem(),
      evaluationBackend: new FakeEvaluator(),
      config: config(),
      startedAt: "2026-01-01T00:00:00.000Z",
      onProgress: (event) => progress.push(event),
    });

    // Per checkpoint the score now carries raw coverage and precision, not a
    // pre-combined quality (quality is a trace-level quantity).
    // T0: coverage 1, precision 1. No maintenance boundary.
    // T1: coverage 1, precision 0.5. Maintenance counts: correction 1/1 and
    //     retention 1/1; discovery and forgetting denominators are 0.
    expect(result.checkpoints[0].coverage.score).toBe(1);
    expect(result.checkpoints[0].precision.score).toBe(1);
    expect(result.checkpoints[0].maintenanceCounts).toBeUndefined();
    expect(result.checkpoints[1].coverage.score).toBe(1);
    expect(result.checkpoints[1].precision.score).toBe(0.5);
    expect(result.checkpoints[1].maintenanceCounts).toBeDefined();

    // Trace macro-averages: coverage mean(1, 1) = 1, precision mean(1, 0.5) =
    // 0.75. Quality = harmonic(1, 0.75) = 6/7. Global maintenance rates:
    // correction 1, retention 1; discovery and forgetting are undefined because
    // their global denominators are 0. Maintenance = mean(1, 1) = 1.
    // LEDGER = (6/7 + 1) / 2 = 13/14.
    expect(result.score.traceCoverage).toBe(1);
    expect(result.score.tracePrecision).toBe(0.75);
    expect(result.score.quality).toBeCloseTo(6 / 7, 10);
    expect(result.score.maintenanceRates.changedKnowledgeCorrection).toBe(1);
    expect(result.score.maintenanceRates.stableRetention).toBe(1);
    expect(result.score.maintenanceRates.newKnowledgeDiscovery).toBeUndefined();
    expect(result.score.maintenanceRates.completeForgetting).toBeUndefined();
    expect(result.score.maintenance).toBe(1);
    expect(result.score.ledgerScore).toBeCloseTo(13 / 14, 10);

    // Diagnostics sit beside the score, not inside it. The only maintenance
    // transition is f2's change at T1, and it succeeds at its own boundary (new
    // version correct, old version forgotten), so no transition was an eligible
    // failure and recoveryRate is undefined. f2@T0 went obsolete at T1 and was
    // forgotten immediately, so it is one resolved record with lifetime 0 and no
    // unresolved versions.
    expect(result.diagnostics.recoveryRate).toBeUndefined();
    expect(result.diagnostics.staleKnowledge).toEqual({
      records: [
        { factVersionId: "f2@T0", lingeredCheckpoints: 0, resolved: true },
      ],
      meanResolvedLifetime: 0,
      unresolvedCount: 0,
    });
    expect(progress.map((event) => event.type)).toEqual([
      "run-start",
      "replay-ready",
      "checkpoint-start",
      "system-complete",
      "artifact-captured",
      "evaluation-start",
      "checkpoint-complete",
      "checkpoint-start",
      "system-complete",
      "artifact-captured",
      "evaluation-start",
      "checkpoint-complete",
      "run-complete",
    ]);
    const t0Complete = progress.find(
      (event) =>
        event.type === "checkpoint-complete" && event.checkpointId === "T0",
    );
    const t1Complete = progress.find(
      (event) =>
        event.type === "checkpoint-complete" && event.checkpointId === "T1",
    );
    expect(t0Complete).toMatchObject({
      forgottenCount: 0,
      obsoleteFactCount: 0,
    });
    expect(t1Complete).toMatchObject({
      forgottenCount: 1,
      obsoleteFactCount: 1,
    });
  });

  test("retains the raw per-item verdicts on each checkpoint", async () => {
    const result = await runBenchmark({
      benchmark: benchmark(),
      system: new FakeSystem(),
      evaluationBackend: new FakeEvaluator(),
      config: config(),
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    // The lossy score counts are explainable because the underlying verdicts are
    // carried through unchanged: T1's invented assertion is exactly the
    // one the evaluator returned, and f2@T0's forgetting verdict is preserved.
    const t1 = result.checkpoints[1].evaluations;

    expect(t1).toBeDefined();
    expect(t1?.precisionEvaluations).toHaveLength(2);
    expect(
      t1?.precisionEvaluations.filter(
        (assertion) => assertion.verdict === "invented",
      ),
    ).toHaveLength(1);
    expect(t1?.forgettingEvaluations).toEqual([
      {
        factId: "f2",
        factVersionId: "f2@T0",
        verdict: "forgotten",
        evidence: [],
        rationale: "",
      },
    ]);
  });

  test("records efficiency: duration passthrough and churn only after T0", async () => {
    const result = await runBenchmark({
      benchmark: benchmark(),
      system: new FakeSystem(),
      evaluationBackend: new FakeEvaluator(),
      config: config(),
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(result.checkpoints[0].efficiency.durationMs).toBe(10);
    expect(result.checkpoints[0].efficiency.churnedLines).toBeUndefined();
    expect(result.checkpoints[1].efficiency.durationMs).toBe(20);
    expect(result.checkpoints[1].efficiency.churnedLines).toBeGreaterThan(0);
  });
});

describe("runBenchmark forgetting watch set", () => {
  let repo: TinyRepo;

  beforeEach(async () => {
    repo = await createTinyRepo([
      { message: "c0", files: { "code.ts": "export const v = 0;\n" } },
      { message: "c1", files: { "code.ts": "export const v = 1;\n" } },
      { message: "c2", files: { "code.ts": "export const v = 2;\n" } },
    ]);
  });

  afterEach(async () => {
    await repo.dispose();
  });

  function benchmark(): LedgerBenchmark {
    return {
      name: "watch-set",
      description: "three checkpoints covering carry-forward and revival",
      sourceRepoPath: repo.repoPath,
      trace: {
        checkpoints: [
          { id: "T0", commit: repo.shas[0] },
          { id: "T1", commit: repo.shas[1] },
          { id: "T2", commit: repo.shas[2] },
        ],
      },
      truthPackage: {
        requirements: [
          { id: "f1", versions: [{ statement: "A", fromCheckpoint: "T0" }] },
          {
            id: "f2",
            versions: [
              { statement: "x1", fromCheckpoint: "T0", untilCheckpoint: "T1" },
              { statement: "x2", fromCheckpoint: "T1", untilCheckpoint: "T2" },
              { statement: "x3", fromCheckpoint: "T2" },
            ],
          },
          {
            id: "f3",
            versions: [
              { statement: "on", fromCheckpoint: "T0", untilCheckpoint: "T1" },
              { statement: "off", fromCheckpoint: "T1", untilCheckpoint: "T2" },
              { statement: "on", fromCheckpoint: "T2" },
            ],
          },
        ],
      },
    };
  }

  function config(): LedgerRunConfig {
    return {
      benchmarkDir: "/nonexistent",
      provider: "fake-provider",
      resultsDir: "/nonexistent",
    };
  }

  test("keeps a forgotten obsolete version under watch and drops a revived one", async () => {
    const evaluator = new RecordingEvaluator();

    await runBenchmark({
      benchmark: benchmark(),
      system: new FakeSystem(),
      evaluationBackend: evaluator,
      config: config(),
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    const watchedAt = (id: string): Set<string> =>
      new Set(evaluator.watchSets.get(id));

    // The first checkpoint has nothing obsolete yet.
    expect(evaluator.watchSets.get("T0")).toEqual([]);

    // At T1 both f2 and f3 have just changed, so their T0 versions go obsolete.
    expect(watchedAt("T1")).toEqual(new Set(["f2@T0", "f3@T0"]));

    // At T2: f2@T0 was judged forgotten at T1 but is still watched, because LEDGER
    // does not treat forgetting as permanent (the Checkpoint 2 decision). f2@T1 is
    // newly obsolete. f3@T0 is dropped because f3 is true again at T2 with its
    // original "on" statement, so that knowledge was revived, not left stale.
    // f3@T1 ("off") is newly obsolete.
    expect(watchedAt("T2")).toEqual(new Set(["f2@T0", "f2@T1", "f3@T1"]));
    expect(watchedAt("T2").has("f3@T0")).toBe(false);
  });
});
