import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  prepareRunDirectory,
  writeArtifactSnapshot,
  writeAssertionInventory,
  writeEvidenceCorpus,
  writeRunFailure,
  writeRunResult,
  writeUnverifiedClaims,
} from "./persistence.js";
import type {
  CheckpointResult,
  LedgerRunResult,
  KnowledgeArtifact,
  PrecisionAssertionEvaluation,
} from "../core/types.js";

/**
 * Build a minimal, serializable run result with the given benchmark name. The
 * fields are otherwise fixed; persistence only serializes the object, so the exact
 * measurements do not matter to these tests.
 *
 * @param benchmarkName - The benchmark name to stamp into the metadata.
 *
 * @returns A run result suitable for round-tripping.
 */
function sampleResult(benchmarkName: string): LedgerRunResult {
  return {
    metadata: {
      benchmarkName,
      difficulty: "medium",
      startedAt: "2026-01-01T00:00:00.000Z",
      system: { provider: "fake-provider" },
    },
    checkpoints: [],
    score: { value: 0, claimHealth: 0 },
    diagnostics: {
      staleKnowledge: { records: [], unresolvedCount: 0 },
    },
  };
}

/**
 * Build a checkpoint carrying the given precision verdicts and no other detail,
 * enough to drive the unverified-claims worklist.
 *
 * @param checkpointId - Identifier for the checkpoint.
 * @param precisionEvaluations - Precision verdicts to attach.
 *
 * @returns A checkpoint result with the supplied precision evaluations.
 */
function checkpointWith(
  checkpointId: string,
  precisionEvaluations: PrecisionAssertionEvaluation[],
): CheckpointResult {
  return {
    checkpointId,
    claims: {
      supported: 0,
      invented: 0,
      stale: 0,
      unverified: precisionEvaluations.filter(
        (claim) => claim.tense === "current" && claim.verdict === "unverified",
      ).length,
      total: precisionEvaluations.filter((claim) => claim.tense === "current")
        .length,
      supportedRate: 0,
      hallucinationRate: 0,
      stalenessRate: 0,
      unverifiedRate: 0,
    },
    evaluationCompleteness: { judged: 0, indeterminate: 0, total: 0, rate: 1 },
    efficiency: { durationMs: 1000, skipped: false },
    evaluations: {
      precisionEvaluations,
      forgettingEvaluations: [],
    },
  };
}

describe("writeUnverifiedClaims", () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanups
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  /**
   * Create a throwaway run directory registered for cleanup.
   *
   * @returns The absolute run directory path.
   */
  async function scratchRunDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ledger-run-"));

    cleanups.push(dir);

    return dir;
  }

  test("writes the worklist with claim text, location, and rationale", async () => {
    const runDir = await scratchRunDir();
    const result = sampleResult("calc-evolution");
    result.checkpoints = [
      checkpointWith("T0", [
        {
          assertion: "maintainers prefer tabs",
          location: "guide.md",
          verdict: "unverified",
          tense: "current",
          adjudicatedBy: "none",
          evidenceIds: [],
          rationale: "Not refuted by bounded evidence.",
        },
      ]),
    ];

    const written = await writeUnverifiedClaims(runDir, result);

    expect(written).toBe(path.join(runDir, "unverified-claims.md"));
    const body = await readFile(written as string, "utf8");
    expect(body).toContain("# Unverified claims");
    expect(body).toContain("## T0");
    expect(body).toContain('- "maintainers prefer tabs"');
    expect(body).toContain("Location: guide.md");
    expect(body).toContain("Why unverified: Not refuted by bounded evidence.");
  });

  test("writes nothing and returns undefined when no claim is unverified", async () => {
    const runDir = await scratchRunDir();
    const result = sampleResult("calc-evolution");
    result.checkpoints = [
      checkpointWith("T0", [
        {
          assertion: "add returns 5",
          location: "guide.md",
          verdict: "supported",
          tense: "current",
          adjudicatedBy: "source",
          evidenceIds: ["src/add.ts"],
          rationale: "Matches source.",
        },
      ]),
    ];

    const written = await writeUnverifiedClaims(runDir, result);

    expect(written).toBeUndefined();
    await expect(
      stat(path.join(runDir, "unverified-claims.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("keeps historical unverified claims audit-only", async () => {
    const runDir = await scratchRunDir();
    const result = sampleResult("calc-evolution");
    result.checkpoints = [
      checkpointWith("T0", [
        {
          assertion: "A removed option once existed.",
          location: "history.md",
          verdict: "unverified",
          tense: "historical",
          adjudicatedBy: "none",
          evidenceIds: [],
          rationale: "No historical evidence was retrieved.",
        },
      ]),
    ];

    await expect(
      writeUnverifiedClaims(runDir, result),
    ).resolves.toBeUndefined();
  });
});

describe("writeRunResult", () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanups
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  /**
   * Create a throwaway results directory registered for cleanup.
   *
   * @returns The absolute results directory path.
   */
  async function scratchResultsDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ledger-results-"));

    cleanups.push(dir);

    return dir;
  }

  test("round-trips the result as result.json in a per-run dir under resultsDir", async () => {
    const resultsDir = await scratchResultsDir();
    const result = sampleResult("my-benchmark");

    const runDir = await writeRunResult(resultsDir, result);

    // The run dir is a direct child of the results dir, named after the benchmark.
    expect(path.dirname(runDir)).toBe(resultsDir);
    expect(path.basename(runDir)).toBe("my-benchmark-2026-01-01T00-00-00-000Z");

    // result.json parses back to exactly what was written.
    const written = JSON.parse(
      await readFile(path.join(runDir, "result.json"), "utf8"),
    );

    expect(written).toEqual(result);
  });

  test("creates a missing results directory recursively", async () => {
    const parent = await scratchResultsDir();
    // A results dir two levels deep that does not exist yet.
    const resultsDir = path.join(parent, "nested", "results");

    const runDir = await writeRunResult(resultsDir, sampleResult("b"));

    expect((await stat(runDir)).isDirectory()).toBe(true);
    expect(path.dirname(runDir)).toBe(resultsDir);
  });

  test("confines a name with path separators to a single sanitized segment", async () => {
    const resultsDir = await scratchResultsDir();

    const runDir = await writeRunResult(resultsDir, sampleResult("a/b/c"));

    // The separators collapse to dashes, so the run dir stays a direct child.
    expect(path.dirname(runDir)).toBe(resultsDir);
    expect(path.basename(runDir)).toBe("a-b-c-2026-01-01T00-00-00-000Z");
  });

  test("confines a traversal name to the results directory", async () => {
    const resultsDir = await scratchResultsDir();

    const runDir = await writeRunResult(
      resultsDir,
      sampleResult("../../escape"),
    );

    // Separators collapse to dashes, so the whole name becomes one segment that is
    // not the bare ".." that a climb would need, and the run dir stays inside
    // resultsDir. (Dots are allowed in a name, so they survive inside the segment.)
    expect(path.dirname(runDir)).toBe(resultsDir);
    expect(path.basename(runDir)).toBe("..-..-escape-2026-01-01T00-00-00-000Z");
    expect(path.basename(runDir).includes(path.sep)).toBe(false);
    expect((await stat(path.join(runDir, "result.json"))).isFile()).toBe(true);
  });

  test("falls back to a default name when the name sanitizes to empty", async () => {
    const resultsDir = await scratchResultsDir();

    const runDir = await writeRunResult(resultsDir, sampleResult("///"));

    expect(path.dirname(runDir)).toBe(resultsDir);
    expect(path.basename(runDir)).toBe("benchmark-2026-01-01T00-00-00-000Z");
  });

  test("persists a pre-judgment assertion inventory in the eventual run directory", async () => {
    const resultsDir = await scratchResultsDir();
    const runDir = await prepareRunDirectory(
      resultsDir,
      "calc-evolution",
      "2026-01-01T00:00:00.000Z",
    );

    await writeAssertionInventory(runDir, {
      checkpointId: "T0",
      totalSectionCount: 2,
      extractedSectionCount: 2,
      units: [],
      candidates: [
        {
          candidateId: "candidate-000001",
          statement: "The library exports add.",
          sourceQuote: "The library exports add.",
          tense: "current",
          sectionId: "guide.md::0000",
          relativePath: "guide.md",
          headingPath: ["Overview"],
          disposition: "kept",
          assertionId: "assertion-000001",
        },
      ],
      groundingEvidence: [
        {
          assertionId: "assertion-000001",
          currentEvidenceIds: ["src/calc.ts::0000"],
          historicalEvidenceIds: [],
          evidenceMapEntryIds: [],
          evidenceMapSelectors: [],
          currentEvidenceMapSourceRefs: [],
          historicalEvidenceMapSourceRefs: [],
          historicalConsulted: false,
          cacheHit: false,
        },
      ],
      keptAssertionCount: 1,
    });

    const written = JSON.parse(
      await readFile(path.join(runDir, "assertions", "T0.json"), "utf8"),
    ) as { keptAssertionCount: number };
    expect(written.keptAssertionCount).toBe(1);
    await expect(stat(path.join(runDir, "result.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("persists complete checkpoint artifacts with a fingerprint manifest", async () => {
    const resultsDir = await scratchResultsDir();
    const runDir = await prepareRunDirectory(
      resultsDir,
      "calc-evolution",
      "2026-01-01T00:00:00.000Z",
    );
    const artifact: KnowledgeArtifact = {
      checkpointId: "T0",
      snapshotDir: path.join(resultsDir, "source"),
      fingerprint: "abc123",
      documents: [
        { relativePath: "quickstart.md", content: "# Quickstart\n" },
        { relativePath: "api/calc.md", content: "# API\n" },
      ],
    };

    await writeArtifactSnapshot(runDir, artifact);

    expect(
      await readFile(
        path.join(runDir, "artifacts", "T0", "api", "calc.md"),
        "utf8",
      ),
    ).toBe("# API\n");
    const manifest = JSON.parse(
      await readFile(path.join(runDir, "artifacts", "T0.json"), "utf8"),
    ) as { fingerprint: string; documents: string[] };
    expect(manifest).toEqual({
      checkpointId: "T0",
      fingerprint: "abc123",
      documents: ["quickstart.md", "api/calc.md"],
    });
  });

  test("persists the normalized source-evidence corpus", async () => {
    const resultsDir = await scratchResultsDir();
    const runDir = await prepareRunDirectory(
      resultsDir,
      "calc-evolution",
      "2026-01-01T00:00:00.000Z",
    );

    await writeEvidenceCorpus(runDir, {
      checkpointId: "T0",
      records: [
        {
          evidenceId: "src/calc.ts::0000",
          sourceRef: "src/calc.ts",
          observedAtCheckpoint: "T0",
          current: true,
          content: "export function add() {}",
        },
      ],
    });

    const written = JSON.parse(
      await readFile(path.join(runDir, "evidence", "T0.json"), "utf8"),
    ) as { records: Array<{ evidenceId: string }> };
    expect(written.records[0].evidenceId).toBe("src/calc.ts::0000");
  });

  test("rejects artifact document paths outside the checkpoint directory", async () => {
    const resultsDir = await scratchResultsDir();
    const runDir = await prepareRunDirectory(
      resultsDir,
      "calc-evolution",
      "2026-01-01T00:00:00.000Z",
    );

    await expect(
      writeArtifactSnapshot(runDir, {
        checkpointId: "T0",
        snapshotDir: path.join(resultsDir, "source"),
        fingerprint: "abc123",
        documents: [{ relativePath: "../escape.md", content: "escape" }],
      }),
    ).rejects.toThrow(/outside/u);
  });

  test("persists bounded failure metadata beside partial audit artifacts", async () => {
    const resultsDir = await scratchResultsDir();
    const runDir = await prepareRunDirectory(
      resultsDir,
      "calc-evolution",
      "2026-01-01T00:00:00.000Z",
    );

    await writeRunFailure(runDir, new Error("precision judgment failed"));

    const written = JSON.parse(
      await readFile(path.join(runDir, "error.json"), "utf8"),
    ) as { name: string; message: string };
    expect(written).toMatchObject({
      name: "Error",
      message: "precision judgment failed",
    });
  });
});
