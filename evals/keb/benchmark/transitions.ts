import { activeVersionAt, versionIdFor } from "./truth-ledger.js";
import type {
  CheckpointTransitions,
  KebBenchmark,
  ObsoleteFactTarget,
} from "../core/types.js";

/**
 * Classify every fact's change from the previous checkpoint to the current one
 * into the four transition buckets, carrying stable version ids. Facts inactive
 * at both checkpoints are omitted. Derived only from the ledger, never from the
 * wiki, so it is fully deterministic.
 *
 * @param benchmark - The benchmark to project against.
 * @param previousCheckpointId - The earlier checkpoint id.
 * @param currentCheckpointId - The later checkpoint id.
 *
 * @returns The structured transitions across this boundary.
 */
export function computeTransitions(
  benchmark: KebBenchmark,
  previousCheckpointId: string,
  currentCheckpointId: string,
): CheckpointTransitions {
  const introduced: CheckpointTransitions["introduced"] = [];
  const changed: CheckpointTransitions["changed"] = [];
  const removed: CheckpointTransitions["removed"] = [];
  const stable: CheckpointTransitions["stable"] = [];

  for (const fact of benchmark.ledger.facts) {
    const previous = activeVersionAt(benchmark, fact, previousCheckpointId);
    const current = activeVersionAt(benchmark, fact, currentCheckpointId);

    if (previous === undefined && current === undefined) {
      continue;
    }

    if (previous === undefined && current !== undefined) {
      introduced.push({
        factId: fact.id,
        factVersionId: versionIdFor(fact.id, current),
        statement: current.statement,
      });
      continue;
    }

    if (previous !== undefined && current === undefined) {
      removed.push({
        factId: fact.id,
        previousVersionId: versionIdFor(fact.id, previous),
        previousStatement: previous.statement,
      });
      continue;
    }

    if (previous !== undefined && current !== undefined) {
      if (previous.statement === current.statement) {
        stable.push({
          factId: fact.id,
          factVersionId: versionIdFor(fact.id, current),
          statement: current.statement,
        });
      } else {
        changed.push({
          factId: fact.id,
          previousVersionId: versionIdFor(fact.id, previous),
          previousStatement: previous.statement,
          currentVersionId: versionIdFor(fact.id, current),
          currentStatement: current.statement,
        });
      }
    }
  }

  return {
    checkpointId: currentCheckpointId,
    previousCheckpointId,
    introduced,
    changed,
    removed,
    stable,
  };
}

/**
 * The forgetting targets for a boundary: the obsolete previous version of every
 * changed fact and of every removed fact. A stable fact has no obsolete version,
 * and an introduced fact has no previous version, so neither contributes. This is
 * the only source of forgetting targets, so no obsolete version is double-counted
 * across passes.
 *
 * @param transitions - The structured transitions for the boundary.
 *
 * @returns One target per obsolete version, changed facts before removed facts.
 */
export function obsoleteTargetsFor(
  transitions: CheckpointTransitions,
): ObsoleteFactTarget[] {
  const targets: ObsoleteFactTarget[] = [];

  for (const fact of transitions.changed) {
    targets.push({
      factId: fact.factId,
      factVersionId: fact.previousVersionId,
      obsoleteStatement: fact.previousStatement,
    });
  }

  for (const fact of transitions.removed) {
    targets.push({
      factId: fact.factId,
      factVersionId: fact.previousVersionId,
      obsoleteStatement: fact.previousStatement,
    });
  }

  return targets;
}
