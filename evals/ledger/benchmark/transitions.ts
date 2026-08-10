import { activeVersionAt, versionIdFor } from "./truth-ledger.js";
import type {
  ActiveTruthFact,
  CheckpointTransitions,
  LedgerBenchmark,
  ObsoleteFactTarget,
} from "../core/types.js";

/**
 * Classify every fact's change from the previous checkpoint to the current one
 * into the four transition buckets, carrying stable version ids. Facts inactive
 * at both checkpoints are omitted. Derived only from requirements, never from the
 * wiki, so it is fully deterministic.
 *
 * @param benchmark - The benchmark to project against.
 * @param previousCheckpointId - The earlier checkpoint id.
 * @param currentCheckpointId - The later checkpoint id.
 *
 * @returns The structured transitions across this boundary.
 */
export function computeTransitions(
  benchmark: LedgerBenchmark,
  previousCheckpointId: string,
  currentCheckpointId: string,
): CheckpointTransitions {
  const introduced: CheckpointTransitions["introduced"] = [];
  const changed: CheckpointTransitions["changed"] = [];
  const removed: CheckpointTransitions["removed"] = [];
  const stable: CheckpointTransitions["stable"] = [];

  for (const fact of benchmark.truthPackage.requirements) {
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

/**
 * Deduplicate obsolete forgetting targets by `factVersionId`, keeping the first
 * occurrence in trace order. A version goes obsolete at exactly one boundary, so
 * a duplicate can only arise from the sticky carry-forward concatenating a target
 * with itself; this is a defensive guard that keeps the evaluator from ever
 * seeing one version twice within a single checkpoint.
 *
 * @param targets - The obsolete targets to deduplicate.
 *
 * @returns The targets with duplicate versions removed, in first-seen order.
 */
function dedupeTargets(targets: ObsoleteFactTarget[]): ObsoleteFactTarget[] {
  const seen = new Set<string>();

  return targets.filter((target) => {
    if (seen.has(target.factVersionId)) {
      return false;
    }

    seen.add(target.factVersionId);
    return true;
  });
}

/**
 * Advance the forgetting watch set across one checkpoint boundary. Once a fact
 * version goes obsolete it stays under watch at every later checkpoint so the
 * forgetting pass keeps re-checking it, which is what makes the Stale-Knowledge
 * Lifetime diagnostic measurable; LEDGER does not treat forgetting as permanent.
 * A target leaves the set only when the requirements revive that exact knowledge
 * (its fact id is active again with the version's own canonical statement), so
 * the wiki is never asked to forget something true again. This never affects the
 * Maintenance Score, because `computeMaintenanceCounts` only ever matches
 * forgetting verdicts against the current boundary's own obsolete versions.
 *
 * @param inputs - The outstanding watch set, the current active facts, and the
 *   versions this boundary newly retires.
 *
 * @returns The deduplicated watch set for the current checkpoint, with carried
 *   targets before this boundary's newly obsolete ones.
 */
export function advanceObsoleteWatchSet(inputs: {
  /**
   * Obsolete versions carried in from earlier boundaries.
   */
  outstanding: ObsoleteFactTarget[];

  /**
   * Facts true at the current checkpoint, used to retire revived targets.
   */
  activeFacts: ActiveTruthFact[];

  /**
   * Versions this boundary newly retires.
   */
  newlyObsolete: ObsoleteFactTarget[];
}): ObsoleteFactTarget[] {
  const activeStatementByFactId = new Map(
    inputs.activeFacts.map((fact): [string, string] => [
      fact.factId,
      fact.statement,
    ]),
  );
  const carried = inputs.outstanding.filter(
    (target) =>
      activeStatementByFactId.get(target.factId) !== target.obsoleteStatement,
  );

  return dedupeTargets([...carried, ...inputs.newlyObsolete]);
}
