import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runBenchmark } from "./runner.js";
import type { BenchmarkProgressEvent } from "./progress-events.js";
import { extractSurface } from "../benchmark/surface.js";
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
 * A fake evaluator that forgets every obsolete target. Claim grounding is canned
 * per checkpoint: two supported claims at T0, and one supported plus one
 * invented at T1, regardless of the surface.
 */
class FakeEvaluator implements EvaluationBackend {
  readonly evidenceMapEntries: string[][] = [];

  async evaluate(input: EvaluationInput): Promise<CheckpointEvaluation> {
    this.evidenceMapEntries.push(
      input.evidenceMap?.entries.map((entry) => entry.id) ?? [],
    );
    const precisionEvaluations: CheckpointEvaluation["precisionEvaluations"] =
      input.artifact.checkpointId === "T0"
        ? [
            {
              assertion: "a",
              location: "page.md",
              verdict: "supported",
              tense: "current",
              adjudicatedBy: "source",
              evidenceIds: ["source::a"],
              rationale: "",
            },
            {
              assertion: "b",
              location: "page.md",
              verdict: "supported",
              tense: "current",
              adjudicatedBy: "source",
              evidenceIds: ["source::b"],
              rationale: "",
            },
          ]
        : [
            {
              assertion: "a",
              location: "page.md",
              verdict: "supported",
              tense: "current",
              adjudicatedBy: "source",
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
          ];

    return {
      forgettingEvaluations: input.obsoleteFacts.map((target) => ({
        factId: target.factId,
        factVersionId: target.factVersionId,
        verdict: "forgotten",
        evidence: [],
        rationale: "",
      })),
      precisionEvaluations,
    };
  }
}

/**
 * An evaluator that records the forgetting watch set (the obsolete versions it is
 * asked about) at each checkpoint and marks every obsolete target `forgotten`.
 * It exists to assert what the runner carries into the forgetting pass across
 * checkpoints, not to produce meaningful claim measurements.
 */
class RecordingEvaluator implements EvaluationBackend {
  readonly watchSets = new Map<string, string[]>();

  async evaluate(input: EvaluationInput): Promise<CheckpointEvaluation> {
    this.watchSets.set(
      input.artifact.checkpointId,
      input.obsoleteFacts.map((target) => target.factVersionId),
    );

    return {
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
    // T0 -> T1 changes one exported symbol's signature (one `changed` element)
    // while the source file itself is unchanged (one `stable` element), so the
    // surface diff yields exactly one obsolete watch target.
    repo = await createTinyRepo([
      {
        message: "c0",
        files: { "code.ts": "export function f(): number {\n  return 1;\n}\n" },
      },
      {
        message: "c1",
        files: {
          "code.ts": "export function f(a: number): number {\n  return a;\n}\n",
        },
      },
    ]);
  });

  afterEach(async () => {
    await repo.dispose();
  });

  function benchmark(): LedgerBenchmark {
    return {
      name: "fake",
      description: "deterministic end-to-end",
      difficulty: "medium",
      sourceRepoPath: repo.repoPath,
      evidenceMap: {
        entries: [
          {
            id: "function-behavior",
            concept: "function signature and behavior",
            evidence: ["code.ts#f"],
          },
        ],
      },
      trace: {
        checkpoints: [
          { id: "T0", commit: repo.shas[0] },
          { id: "T1", commit: repo.shas[1] },
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

  test("produces current claim state and forgetting diagnostics", async () => {
    const progress: BenchmarkProgressEvent[] = [];
    const evaluator = new FakeEvaluator();
    const result = await runBenchmark({
      benchmark: benchmark(),
      system: new FakeSystem(),
      evaluationBackend: evaluator,
      config: config(),
      startedAt: "2026-01-01T00:00:00.000Z",
      onProgress: (event) => progress.push(event),
    });

    expect(result.checkpoints[0].claims).toEqual({
      supported: 2,
      invented: 0,
      stale: 0,
      unverified: 0,
      total: 2,
      supportedRate: 1,
      hallucinationRate: 0,
      stalenessRate: 0,
      unverifiedRate: 0,
    });
    expect(result.checkpoints[1].claims.supportedRate).toBe(0.5);
    expect(result.checkpoints[1].claims.hallucinationRate).toBe(0.5);
    expect(evaluator.evidenceMapEntries).toEqual([
      ["function-behavior"],
      ["function-behavior"],
    ]);

    // `f`'s T0 version went obsolete at T1 and was forgotten immediately, so the
    // diagnostic has one resolved record with lifetime 0 and no unresolved
    // versions.
    const surfaceT0 = await extractSurface(repo.repoPath, repo.shas[0]);
    const obsoleteVersionId = surfaceT0.find(
      (item) => item.factId === "symbol:f",
    )?.factVersionId;
    expect(obsoleteVersionId).toBeDefined();
    expect(result.diagnostics.staleKnowledge).toEqual({
      records: [
        {
          factVersionId: obsoleteVersionId,
          lingeredCheckpoints: 0,
          resolved: true,
        },
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
      claimCount: 2,
      forgottenCount: 0,
      obsoleteFactCount: 0,
    });
    expect(t1Complete).toMatchObject({
      claimCount: 2,
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

    // The lossy claim counts are explainable because the underlying verdicts are
    // carried through unchanged: T1's invented assertion is exactly the one the
    // evaluator returned, and the forgetting verdict for `f`'s obsolete T0 version
    // is preserved.
    const surfaceT0 = await extractSurface(repo.repoPath, repo.shas[0]);
    const obsoleteVersionId = surfaceT0.find(
      (item) => item.factId === "symbol:f",
    )?.factVersionId;
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
        factId: "symbol:f",
        factVersionId: obsoleteVersionId,
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
    expect(result.score.claimHealth).toBe(0.75);
    expect(result.score.value).toBe(0.75);
  });
});

describe("runBenchmark forgetting watch set", () => {
  let repo: TinyRepo;

  beforeEach(async () => {
    // Two exported symbols drive the watch set. `changing` mutates its signature
    // at every checkpoint (three distinct versions), so its earlier versions
    // accumulate. `reviving` flips its return type off at T1 and back to the exact
    // T0 signature at T2, so its T0 version is revived (byte-identical statement)
    // and must leave the watch set while its T1 version becomes obsolete.
    const source = (
      changing: string,
      reviving: string,
    ): { "code.ts": string } => ({
      "code.ts":
        `export function changing(${changing}): number {\n  return 0;\n}\n\n` +
        `export function reviving(): ${reviving} {\n  return ${reviving};\n}\n`,
    });
    repo = await createTinyRepo([
      { message: "c0", files: source("a: number", "1") },
      { message: "c1", files: source("a: number, b: number", "2") },
      { message: "c2", files: source("a: number, b: number, c: number", "1") },
    ]);
  });

  afterEach(async () => {
    await repo.dispose();
  });

  function benchmark(): LedgerBenchmark {
    return {
      name: "watch-set",
      description: "three checkpoints covering carry-forward and revival",
      difficulty: "medium",
      sourceRepoPath: repo.repoPath,
      trace: {
        checkpoints: [
          { id: "T0", commit: repo.shas[0] },
          { id: "T1", commit: repo.shas[1] },
          { id: "T2", commit: repo.shas[2] },
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
    const surfaceT0 = await extractSurface(repo.repoPath, repo.shas[0]);
    const surfaceT1 = await extractSurface(repo.repoPath, repo.shas[1]);
    const versionId = (surface: typeof surfaceT0, factId: string): string => {
      const item = surface.find((entry) => entry.factId === factId);
      if (item === undefined) {
        throw new Error(`missing surface item ${factId}`);
      }
      return item.factVersionId;
    };
    const changingT0 = versionId(surfaceT0, "symbol:changing");
    const changingT1 = versionId(surfaceT1, "symbol:changing");
    const revivingT0 = versionId(surfaceT0, "symbol:reviving");
    const revivingT1 = versionId(surfaceT1, "symbol:reviving");

    // The first checkpoint has nothing obsolete yet.
    expect(evaluator.watchSets.get("T0")).toEqual([]);

    // At T1 both symbols have just changed, so their T0 versions go obsolete.
    expect(watchedAt("T1")).toEqual(new Set([changingT0, revivingT0]));

    // At T2: `changing`'s T0 version was judged forgotten at T1 but is still
    // watched, because LEDGER does not treat forgetting as permanent (the
    // Checkpoint 2 decision). `changing`'s T1 version is newly obsolete.
    // `reviving`'s T0 version is dropped because `reviving` has the exact T0
    // signature again at T2, so that knowledge was revived, not left stale.
    // `reviving`'s T1 version is newly obsolete.
    expect(watchedAt("T2")).toEqual(
      new Set([changingT0, changingT1, revivingT1]),
    );
    expect(watchedAt("T2").has(revivingT0)).toBe(false);
  });
});
