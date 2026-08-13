import { readFile } from "node:fs/promises";
import path from "node:path";

import { BenchmarkValidationError } from "../core/errors.js";
import type { BenchmarkDifficulty, LedgerBenchmark } from "../core/types.js";
import { ensureSourceRepoAvailable } from "./source-repo.js";
import { validateBenchmark, validateEvidenceMapSources } from "./validation.js";

/**
 * Name of the manifest file inside a benchmark directory.
 */
const BENCHMARK_FILE = "benchmark.json";

/**
 * The difficulty labels a benchmark manifest may declare, in ascending order.
 * Used as the allowlist the untrusted `difficulty` field is checked against.
 */
const DIFFICULTIES: readonly BenchmarkDifficulty[] = ["easy", "medium", "hard"];

/**
 * Optional benchmark-loading behavior for callers that do not replay source.
 */
export interface LoadBenchmarkOptions {
  /**
   * Whether to reconstruct a missing Git source repository from its committed
   * bundle.
   *
   * @default true
   */
  ensureSourceRepo?: boolean;
}

/**
 * Raw on-disk shape of `benchmark.json`, before path resolution and validation.
 * Kept separate from `LedgerBenchmark` because the file stores a relative
 * `sourceRepo` while the domain type stores an absolute `sourceRepoPath`.
 *
 * Every field is optional and typed `unknown` on purpose: the file is untrusted
 * input, so neither the presence nor the type of any key is assumed until
 * `loadBenchmark` and `validateBenchmark` have checked it.
 */
interface RawBenchmark {
  /**
   * Human-readable benchmark name for reports. Typed `unknown` because the raw
   * file is untrusted until checked.
   *
   * @default an empty string when absent or not a string, since the name is
   *   only cosmetic
   */
  name?: unknown;

  /**
   * Free-text description of what the benchmark exercises, for reports. Typed
   * `unknown` because the raw file is untrusted until checked.
   *
   * @default an empty string when absent or not a string, since the description
   *   is only cosmetic
   */
  description?: unknown;

  /**
   * Author-declared difficulty rating. Typed `unknown` because the raw file is
   * untrusted until checked.
   *
   * @default no fallback; an absent or unrecognized value is rejected with a
   *   `BenchmarkValidationError` so every benchmark declares an explicit rating
   */
  difficulty?: unknown;

  /**
   * Path to the repository the benchmark replays, written relative to the
   * benchmark directory. `loadBenchmark` resolves it against that directory into
   * the absolute `sourceRepoPath` on `LedgerBenchmark`.
   *
   * @default no fallback; an absent, non-string, or empty value is rejected with
   *   a `BenchmarkValidationError` before any path resolution
   */
  sourceRepo?: unknown;

  /**
   * Ordered checkpoint sequence to replay. Passed straight to
   * `validateBenchmark`, whose deep structural checks make the later cast to
   * `LedgerBenchmark["trace"]` sound; no shape is assumed here.
   *
   * @default no fallback; `validateBenchmark` rejects an absent or malformed
   *   trace with a `BenchmarkValidationError`
   */
  trace?: unknown;

  /**
   * Optional evaluator-only semantic routing metadata. Deep validation happens
   * in `validateBenchmark` alongside the trace checks.
   */
  evidenceMap?: unknown;
}

/**
 * Load, resolve, and validate the benchmark in `benchmarkDir`.
 *
 * @param benchmarkDir - Absolute path to the directory containing
 *   `benchmark.json`.
 * @param options - Optional source-materialization behavior.
 *
 * @returns The validated benchmark with `sourceRepoPath` resolved to an absolute
 *   path.
 *
 * @throws BenchmarkValidationError when the file is missing, unparseable, or
 *   fails an integrity check.
 */
export async function loadBenchmark(
  benchmarkDir: string,
  options: LoadBenchmarkOptions = {},
): Promise<LedgerBenchmark> {
  const file = path.join(benchmarkDir, BENCHMARK_FILE);

  let raw: RawBenchmark;

  try {
    raw = JSON.parse(await readFile(file, "utf8")) as RawBenchmark;
  } catch (error) {
    throw new BenchmarkValidationError(
      `Could not read or parse ${file}: ${(error as Error).message}`,
    );
  }

  if (typeof raw.sourceRepo !== "string" || raw.sourceRepo.length === 0) {
    throw new BenchmarkValidationError(
      `${file}: "sourceRepo" must be a non-empty string.`,
    );
  }

  if (
    typeof raw.difficulty !== "string" ||
    !DIFFICULTIES.includes(raw.difficulty as BenchmarkDifficulty)
  ) {
    throw new BenchmarkValidationError(
      `${file}: "difficulty" must be one of ${DIFFICULTIES.join(", ")}.`,
    );
  }
  const difficulty = raw.difficulty as BenchmarkDifficulty;

  const sourceRepoPath = path.resolve(benchmarkDir, raw.sourceRepo);

  // Reconstruct the source working tree from its committed bundle when a fresh
  // checkout left it absent. A no-op for benchmarks that ship a real repository.
  if (options.ensureSourceRepo !== false) {
    await ensureSourceRepoAvailable(benchmarkDir, sourceRepoPath);
  }

  const benchmark: LedgerBenchmark = {
    name: typeof raw.name === "string" ? raw.name : "",
    description: typeof raw.description === "string" ? raw.description : "",
    difficulty,
    sourceRepoPath,
    evidenceMap: raw.evidenceMap as LedgerBenchmark["evidenceMap"],
    // Cast is deliberate: validateBenchmark performs the deep structural checks
    // that make this cast sound, and throws before the value is used otherwise.
    trace: raw.trace as LedgerBenchmark["trace"],
  };

  validateBenchmark(benchmark);
  if (options.ensureSourceRepo !== false) {
    await validateEvidenceMapSources(benchmark);
  }

  return benchmark;
}
