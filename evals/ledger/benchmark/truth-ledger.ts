import { BenchmarkValidationError } from "../core/errors.js";
import type {
  ActiveTruthFact,
  LedgerBenchmark,
  TruthFact,
  TruthFactVersion,
} from "../core/types.js";

/**
 * Fallback category applied during projection so consumers never handle an
 * absent category.
 */
const DEFAULT_CATEGORY = "uncategorized";

/**
 * Derive the stable version id for a fact version, `${factId}@${fromCheckpoint}`.
 * Deterministic and unique per version: two checkpoints that share a version
 * share this id, and a changed fact gets a fresh one.
 *
 * @param factId - The logical fact id.
 * @param version - The version to identify.
 *
 * @returns The stable version id.
 */
export function versionIdFor(
  factId: string,
  version: TruthFactVersion,
): string {
  return `${factId}@${version.fromCheckpoint}`;
}

/**
 * Resolve a checkpoint id to its zero-based position in the trace.
 *
 * @param benchmark - The benchmark whose trace defines the ordering.
 * @param checkpointId - The checkpoint id to locate.
 *
 * @returns The zero-based index.
 *
 * @throws BenchmarkValidationError when the id is not in the trace.
 */
export function checkpointIndex(
  benchmark: LedgerBenchmark,
  checkpointId: string,
): number {
  const position = benchmark.trace.checkpoints.findIndex(
    (checkpoint) => checkpoint.id === checkpointId,
  );

  if (position === -1) {
    throw new BenchmarkValidationError(
      `Unknown checkpoint id "${checkpointId}".`,
    );
  }

  return position;
}

/**
 * The exclusive end position of a version: the index of its `untilCheckpoint`,
 * or the trace length when the version runs to the end.
 *
 * @param benchmark - The benchmark whose trace defines the ordering.
 * @param version - The version to measure.
 *
 * @returns The exclusive end index.
 */
function versionEnd(
  benchmark: LedgerBenchmark,
  version: TruthFactVersion,
): number {
  return version.untilCheckpoint === undefined
    ? benchmark.trace.checkpoints.length
    : checkpointIndex(benchmark, version.untilCheckpoint);
}

/**
 * The version of a fact active at a given position, or undefined when none is.
 *
 * @param benchmark - The benchmark whose trace defines the ordering.
 * @param fact - The fact to project.
 * @param position - The zero-based checkpoint position.
 *
 * @returns The active version, or undefined.
 */
function activeVersion(
  benchmark: LedgerBenchmark,
  fact: TruthFact,
  position: number,
): TruthFactVersion | undefined {
  return fact.versions.find((version) => {
    const from = checkpointIndex(benchmark, version.fromCheckpoint);
    const until = versionEnd(benchmark, version);

    return from <= position && position < until;
  });
}

/**
 * The statement of a fact that is true at a checkpoint, or undefined when the
 * fact is not active there.
 *
 * @param benchmark - The benchmark to project against.
 * @param fact - The fact to project.
 * @param checkpointId - The checkpoint id to project to.
 *
 * @returns The active statement, or undefined.
 */
export function activeStatement(
  benchmark: LedgerBenchmark,
  fact: TruthFact,
  checkpointId: string,
): string | undefined {
  const version = activeVersion(
    benchmark,
    fact,
    checkpointIndex(benchmark, checkpointId),
  );

  return version?.statement;
}

/**
 * The fact version active at a checkpoint, or undefined when the fact is not
 * active there. Exposes the version object so callers can read both its statement
 * and, via `versionIdFor`, its stable id.
 *
 * @param benchmark - The benchmark to project against.
 * @param fact - The fact to project.
 * @param checkpointId - The checkpoint id to project to.
 *
 * @returns The active version, or undefined.
 */
export function activeVersionAt(
  benchmark: LedgerBenchmark,
  fact: TruthFact,
  checkpointId: string,
): TruthFactVersion | undefined {
  return activeVersion(
    benchmark,
    fact,
    checkpointIndex(benchmark, checkpointId),
  );
}

/**
 * Every material requirement true at a checkpoint, projected to its active
 * statement and stable version id.
 *
 * @param benchmark - The benchmark to project against.
 * @param checkpointId - The checkpoint id to project to.
 *
 * @returns The active facts, in Truth Package requirement order.
 */
export function getActiveFacts(
  benchmark: LedgerBenchmark,
  checkpointId: string,
): ActiveTruthFact[] {
  const position = checkpointIndex(benchmark, checkpointId);
  const active: ActiveTruthFact[] = [];

  for (const fact of benchmark.truthPackage.requirements) {
    const version = activeVersion(benchmark, fact, position);

    if (version !== undefined) {
      active.push({
        factId: fact.id,
        factVersionId: versionIdFor(fact.id, version),
        category: fact.category ?? DEFAULT_CATEGORY,
        statement: version.statement,
      });
    }
  }

  return active;
}
