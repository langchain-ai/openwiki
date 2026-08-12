import path from "node:path";

import { BenchmarkValidationError } from "../core/errors.js";
import type { LedgerBenchmark, LedgerCheckpoint } from "../core/types.js";
import { COMMIT_PATTERN, git } from "../replay/git.js";

/** Safe single-segment checkpoint identifier accepted from benchmark JSON. */
const CHECKPOINT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;

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
  validateEvidenceMap(benchmark.evidenceMap);
}

/** Resolve the path or path-glob portion of an optional symbol selector. */
function evidenceSelectorPath(selector: string): string {
  return selector.split("#", 1)[0];
}

/**
 * Confirm every authored selector resolves at one or more trace checkpoints.
 * A selector may legitimately be absent at most checkpoints because the map is
 * benchmark-wide and APIs evolve; only selectors absent from the entire trace
 * are rejected as likely authoring mistakes.
 */
export async function validateEvidenceMapSources(
  benchmark: LedgerBenchmark,
): Promise<void> {
  if (benchmark.evidenceMap === undefined) {
    return;
  }

  const filesAcrossTrace = new Set<string>();
  for (const checkpoint of benchmark.trace.checkpoints) {
    const output = await git(benchmark.sourceRepoPath, [
      "ls-tree",
      "-r",
      "--name-only",
      checkpoint.commit,
    ]);
    output
      .split("\n")
      .filter((sourcePath) => sourcePath.length > 0)
      .forEach((sourcePath) => filesAcrossTrace.add(sourcePath));
  }

  for (const entry of benchmark.evidenceMap.entries) {
    for (const selector of entry.evidence) {
      const pattern = evidenceSelectorPath(selector);
      const resolves = [...filesAcrossTrace].some(
        (sourcePath) =>
          pattern === sourcePath || path.posix.matchesGlob(sourcePath, pattern),
      );
      if (!resolves) {
        throw new BenchmarkValidationError(
          `Evidence-map entry "${entry.id}" selector "${selector}" does not resolve at any benchmark checkpoint.`,
        );
      }
    }
  }
}

/** Validate one relative path or `path#symbol` evidence selector. */
function validateEvidenceSelector(selector: string, entryId: string): void {
  const parts = selector.split("#");
  const sourcePath = evidenceSelectorPath(selector);

  if (
    parts.length > 2 ||
    sourcePath.length === 0 ||
    sourcePath.startsWith("/") ||
    sourcePath.includes("\\") ||
    sourcePath.split("/").some((segment) => segment === "..") ||
    (parts.length === 2 && parts[1].length === 0)
  ) {
    throw new BenchmarkValidationError(
      `Evidence-map entry "${entryId}" has invalid selector "${selector}". Selectors must be relative POSIX paths, optional path globs, or path#symbol references.`,
    );
  }
}

/** Validate optional evaluator-only semantic evidence routing metadata. */
function validateEvidenceMap(
  evidenceMap: LedgerBenchmark["evidenceMap"],
): void {
  if (evidenceMap === undefined) {
    return;
  }

  if (!isObject(evidenceMap) || !Array.isArray(evidenceMap.entries)) {
    throw new BenchmarkValidationError(
      "evidenceMap.entries must be a non-empty array when evidenceMap is provided.",
    );
  }
  if (evidenceMap.entries.length === 0) {
    throw new BenchmarkValidationError(
      "evidenceMap.entries must be a non-empty array when evidenceMap is provided.",
    );
  }

  const unexpectedMapField = Object.keys(evidenceMap).find(
    (field) => field !== "entries",
  );
  if (unexpectedMapField !== undefined) {
    throw new BenchmarkValidationError(
      `evidenceMap has unsupported field "${unexpectedMapField}".`,
    );
  }

  const ids = new Set<string>();
  evidenceMap.entries.forEach((entry, position) => {
    if (!isObject(entry)) {
      throw new BenchmarkValidationError(
        `Evidence-map entry at position ${position} is not an object.`,
      );
    }
    const unexpectedEntryField = Object.keys(entry).find(
      (field) => !["id", "concept", "evidence"].includes(field),
    );
    if (unexpectedEntryField !== undefined) {
      throw new BenchmarkValidationError(
        `Evidence-map entry at position ${position} has unsupported field "${unexpectedEntryField}". Entries may contain only id, concept, and evidence.`,
      );
    }
    if (typeof entry.id !== "string" || entry.id.trim().length === 0) {
      throw new BenchmarkValidationError(
        `Evidence-map entry at position ${position} has an empty id.`,
      );
    }
    if (ids.has(entry.id)) {
      throw new BenchmarkValidationError(
        `Duplicate evidence-map entry id "${entry.id}".`,
      );
    }
    ids.add(entry.id);

    if (
      typeof entry.concept !== "string" ||
      entry.concept.trim().length === 0
    ) {
      throw new BenchmarkValidationError(
        `Evidence-map entry "${entry.id}" has an empty concept.`,
      );
    }
    if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
      throw new BenchmarkValidationError(
        `Evidence-map entry "${entry.id}" must declare at least one evidence selector.`,
      );
    }

    const selectors = new Set<string>();
    for (const selector of entry.evidence) {
      if (typeof selector !== "string" || selector.trim().length === 0) {
        throw new BenchmarkValidationError(
          `Evidence-map entry "${entry.id}" has an empty evidence selector.`,
        );
      }
      if (selectors.has(selector)) {
        throw new BenchmarkValidationError(
          `Evidence-map entry "${entry.id}" repeats selector "${selector}".`,
        );
      }
      selectors.add(selector);
      validateEvidenceSelector(selector, entry.id);
    }
  });
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

    if (
      typeof checkpoint.id !== "string" ||
      !CHECKPOINT_ID_PATTERN.test(checkpoint.id) ||
      checkpoint.id === "." ||
      checkpoint.id === ".."
    ) {
      throw new BenchmarkValidationError(
        `Checkpoint at position ${position} has an invalid id. Use 1-64 letters, numbers, dots, underscores, or hyphens; "." and ".." are not allowed.`,
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
