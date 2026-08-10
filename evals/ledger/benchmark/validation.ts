import { BenchmarkValidationError } from "../core/errors.js";
import type { LedgerBenchmark, LedgerCheckpoint } from "../core/types.js";

/**
 * Git commit SHAs LEDGER accepts: 7 to 40 lowercase hex characters. Enforced before
 * any SHA is passed to Git so a malformed benchmark cannot smuggle an argument.
 */
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;

/**
 * Whether a value is a non-null object, the precondition for reading fields off a
 * trace entry. The benchmark reaches validation cast from untrusted JSON, so an
 * entry the static type claims is an object can still be `null` or a primitive at
 * runtime; guarding with this before property access keeps a malformed entry a
 * `BenchmarkValidationError` rather than a raw `TypeError`.
 *
 * @param value - The value to test.
 *
 * @returns True when `value` is a non-null object.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Validate a benchmark's trace structurally, throwing on the first problem: a
 * non-empty trace with unique checkpoint ids and well-formed commit SHAs. The
 * public surface each checkpoint yields is not the manifest's concern (source is
 * now the ground truth), so this no longer inspects a hand-authored census; the
 * loader's surface preflight confirms each checkpoint has a scorable surface.
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

  buildCheckpointIndex(checkpoints);
}

/**
 * Build a map from checkpoint id to its position in the trace, rejecting empty
 * ids, duplicate ids, and malformed commit SHAs.
 *
 * @param checkpoints - The trace checkpoints in order.
 *
 * @returns A map from checkpoint id to zero-based index.
 */
export function buildCheckpointIndex(
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
