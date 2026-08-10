import { BenchmarkValidationError } from "../core/errors.js";
import { getActiveFacts } from "./truth-ledger.js";
import type {
  LedgerBenchmark,
  LedgerCheckpoint,
  TruthFact,
} from "../core/types.js";

/**
 * Git commit SHAs LEDGER accepts: 7 to 40 lowercase hex characters. Enforced before
 * any SHA is passed to Git so a malformed benchmark cannot smuggle an argument.
 */
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;

/**
 * Whether a value is a non-null object, the precondition for reading fields off a
 * trace or requirement entry. The benchmark reaches validation cast from untrusted
 * JSON, so an entry the static type claims is an object can still be `null` or a
 * primitive at runtime; guarding with this before property access keeps a
 * malformed entry a `BenchmarkValidationError` rather than a raw `TypeError`.
 *
 * @param value - The value to test.
 *
 * @returns True when `value` is a non-null object.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Validate a benchmark's internal consistency, throwing on the first problem.
 * Checks: a non-empty trace with unique checkpoint ids and well-formed commits;
 * at least one fact; per fact, at least one version whose checkpoint references
 * exist, whose ranges are ordered `from < until`, and whose ranges do not
 * overlap; and that every checkpoint has at least one active coverage fact, so
 * Knowledge Coverage is well-defined at every checkpoint the runner scores.
 *
 * @param benchmark - The assembled benchmark to check.
 *
 * @throws BenchmarkValidationError on the first inconsistency found.
 */
export function validateBenchmark(benchmark: LedgerBenchmark): void {
  const checkpoints = benchmark.trace?.checkpoints;

  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    throw new BenchmarkValidationError(
      "trace.checkpoints must be a non-empty array.",
    );
  }

  const index = buildCheckpointIndex(checkpoints);

  const facts = benchmark.truthPackage?.requirements;

  if (!Array.isArray(facts) || facts.length === 0) {
    throw new BenchmarkValidationError(
      "truthPackage.requirements must be a non-empty array.",
    );
  }

  const seenFactIds = new Set<string>();

  for (const fact of facts) {
    validateFact(fact, index, seenFactIds);
  }

  assertEveryCheckpointHasActiveFacts(benchmark, checkpoints);
}

/**
 * Build a map from checkpoint id to its position in the trace, rejecting empty
 * ids, duplicate ids, and malformed commit SHAs.
 *
 * @param checkpoints - The trace checkpoints in order.
 *
 * @returns A map from checkpoint id to zero-based index.
 */
function buildCheckpointIndex(
  checkpoints: LedgerCheckpoint[],
): Map<string, number> {
  const index = new Map<string, number>();

  checkpoints.forEach((checkpoint, position) => {
    if (!isObject(checkpoint)) {
      throw new BenchmarkValidationError(
        `Checkpoint at position ${position} is not an object.`,
      );
    }

    if (typeof checkpoint.id !== "string" || checkpoint.id.length === 0) {
      throw new BenchmarkValidationError(
        `Checkpoint at position ${position} has an empty id.`,
      );
    }

    if (index.has(checkpoint.id)) {
      throw new BenchmarkValidationError(
        `Duplicate checkpoint id "${checkpoint.id}".`,
      );
    }

    if (
      typeof checkpoint.commit !== "string" ||
      !COMMIT_PATTERN.test(checkpoint.commit)
    ) {
      throw new BenchmarkValidationError(
        `Checkpoint "${checkpoint.id}" has an invalid commit SHA.`,
      );
    }

    index.set(checkpoint.id, position);
  });

  return index;
}

/**
 * Validate one fact: unique id, at least one version, references to real
 * checkpoints, ordered ranges, and non-overlapping ranges.
 *
 * @param fact - The fact to check.
 * @param index - Checkpoint id to position map for the trace.
 * @param seenFactIds - Accumulator of ids already seen, to detect duplicates.
 */
function validateFact(
  fact: TruthFact,
  index: Map<string, number>,
  seenFactIds: Set<string>,
): void {
  if (!isObject(fact)) {
    throw new BenchmarkValidationError("A fact entry is not an object.");
  }

  if (typeof fact.id !== "string" || fact.id.length === 0) {
    throw new BenchmarkValidationError("A fact has an empty id.");
  }

  if (seenFactIds.has(fact.id)) {
    throw new BenchmarkValidationError(`Duplicate fact id "${fact.id}".`);
  }

  seenFactIds.add(fact.id);

  if (!Array.isArray(fact.versions) || fact.versions.length === 0) {
    throw new BenchmarkValidationError(
      `Fact "${fact.id}" must have at least one version.`,
    );
  }

  const ranges: Array<{ from: number; until: number }> = [];

  for (const version of fact.versions) {
    if (!isObject(version)) {
      throw new BenchmarkValidationError(
        `Fact "${fact.id}" has a version that is not an object.`,
      );
    }

    if (
      typeof version.statement !== "string" ||
      version.statement.length === 0
    ) {
      throw new BenchmarkValidationError(
        `Fact "${fact.id}" has a version with an empty statement.`,
      );
    }

    if (
      version.evidenceRefs !== undefined &&
      (!Array.isArray(version.evidenceRefs) ||
        version.evidenceRefs.length === 0 ||
        version.evidenceRefs.some(
          (reference) =>
            typeof reference !== "string" || reference.length === 0,
        ))
    ) {
      throw new BenchmarkValidationError(
        `Fact "${fact.id}" has invalid evidenceRefs; expected non-empty source references.`,
      );
    }

    const from = index.get(version.fromCheckpoint);

    if (from === undefined) {
      throw new BenchmarkValidationError(
        `Fact "${fact.id}" references unknown fromCheckpoint "${version.fromCheckpoint}".`,
      );
    }

    let until = index.size;

    if (version.untilCheckpoint !== undefined) {
      const resolved = index.get(version.untilCheckpoint);

      if (resolved === undefined) {
        throw new BenchmarkValidationError(
          `Fact "${fact.id}" references unknown untilCheckpoint "${version.untilCheckpoint}".`,
        );
      }

      if (resolved <= from) {
        throw new BenchmarkValidationError(
          `Fact "${fact.id}" has a version whose untilCheckpoint is not after its fromCheckpoint.`,
        );
      }

      until = resolved;
    }

    ranges.push({ from, until });
  }

  assertNoOverlap(fact.id, ranges);
}

/**
 * Assert that a fact's version ranges (half-open `[from, until)`) do not overlap.
 *
 * @param factId - The fact id, for error messages.
 * @param ranges - The resolved numeric ranges.
 */
function assertNoOverlap(
  factId: string,
  ranges: Array<{ from: number; until: number }>,
): void {
  const sorted = [...ranges].sort((a, b) => a.from - b.from);

  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].from < sorted[i - 1].until) {
      throw new BenchmarkValidationError(
        `Fact "${factId}" has overlapping version ranges.`,
      );
    }
  }
}

/**
 * Assert that every checkpoint has at least one active material requirement so
 * Knowledge Coverage has a meaningful denominator. Runs after fact validation,
 * so every version range is already known well-formed.
 *
 * @param benchmark - The benchmark to project active facts from.
 * @param checkpoints - The trace checkpoints, in order.
 *
 * @throws BenchmarkValidationError naming the first checkpoint with no active
 * coverage facts.
 */
function assertEveryCheckpointHasActiveFacts(
  benchmark: LedgerBenchmark,
  checkpoints: LedgerCheckpoint[],
): void {
  for (const checkpoint of checkpoints) {
    if (getActiveFacts(benchmark, checkpoint.id).length === 0) {
      throw new BenchmarkValidationError(
        `Checkpoint "${checkpoint.id}" has no active coverage facts. Every checkpoint must ` +
          `have at least one material Truth Package requirement so Knowledge Coverage is ` +
          `well-defined there.`,
      );
    }
  }
}
