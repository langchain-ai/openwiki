import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { writeRunResult } from "./persistence.js";
import type { KebRunResult } from "../core/types.js";

/**
 * Build a minimal, serializable run result with the given benchmark name. The
 * fields are otherwise fixed; persistence only serializes the object, so the exact
 * scores do not matter to these tests.
 *
 * @param benchmarkName - The benchmark name to stamp into the metadata.
 *
 * @returns A run result suitable for round-tripping.
 */
function sampleResult(benchmarkName: string): KebRunResult {
  return {
    metadata: {
      benchmarkName,
      startedAt: "2026-01-01T00:00:00.000Z",
      system: { provider: "fake-provider" },
      evaluatorPromptVersion: "fake-1",
    },
    checkpoints: [],
    score: {
      traceCoverage: 1,
      tracePrecision: 1,
      quality: 1,
      maintenanceRates: {},
      kebScore: 1,
    },
    diagnostics: {
      staleKnowledge: { records: [], unresolvedCount: 0 },
    },
  };
}

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
    const dir = await mkdtemp(path.join(os.tmpdir(), "keb-results-"));

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
});
