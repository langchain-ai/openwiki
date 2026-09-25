import type { KnowledgeArtifact, KnowledgeDocument } from "../core/types.js";

/**
 * Split a document body into lines. An absent document (undefined) contributes no
 * lines, so a purely added or deleted document is not charged a phantom empty
 * line; a genuinely empty existing document still splits to a single empty line,
 * so replacing one empty document with another registers no churn.
 *
 * @param body - The document body, or undefined when the document is absent on
 *   this side of the diff.
 *
 * @returns The body's lines, or an empty array when the document is absent.
 */
function splitLines(body: string | undefined): string[] {
  return body === undefined ? [] : body.split("\n");
}

/**
 * Count lines that differ between two document bodies as a multiset symmetric
 * difference: lines in `a` that `b` lacks (removed) plus lines in `b` that `a`
 * lacks (added), respecting duplicate counts.
 *
 * @param a - The previous document body, or undefined when the document is new.
 * @param b - The current document body, or undefined when the document was
 *   deleted.
 *
 * @returns The number of differing lines.
 */
function lineDelta(a: string | undefined, b: string | undefined): number {
  const counts = new Map<string, number>();

  for (const line of splitLines(a)) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }

  for (const line of splitLines(b)) {
    counts.set(line, (counts.get(line) ?? 0) - 1);
  }

  let delta = 0;

  for (const count of counts.values()) {
    delta += Math.abs(count);
  }

  return delta;
}

/**
 * Index an artifact's documents by relative path for lookup.
 *
 * @param documents - The artifact documents.
 *
 * @returns A map from relative path to content.
 */
function indexDocuments(documents: KnowledgeDocument[]): Map<string, string> {
  return new Map(documents.map((doc) => [doc.relativePath, doc.content]));
}

/**
 * Total churn between two artifacts: an order-insensitive, added-plus-removed-line
 * content-churn proxy, summed across the union of their document paths. This is
 * deliberately a multiset symmetric difference of lines, not an edit distance:
 * each distinct line is charged by how its occurrence count changed, so moving
 * lines around within a document with no content change contributes zero churn.
 * Cheap and fully deterministic, and diagnostic-only; it never feeds the LEDGER
 * Score. Undefined when there is no previous artifact (the first checkpoint has
 * nothing to diff against).
 *
 * @param previous - The prior checkpoint's artifact, or undefined at the first
 *   checkpoint.
 * @param current - The current checkpoint's artifact.
 *
 * @returns The churned line count, or undefined at the first checkpoint.
 */
export function computeChurn(
  previous: KnowledgeArtifact | undefined,
  current: KnowledgeArtifact,
): number | undefined {
  if (previous === undefined) {
    return undefined;
  }

  const before = indexDocuments(previous.documents);
  const after = indexDocuments(current.documents);
  const paths = new Set([...before.keys(), ...after.keys()]);

  let churn = 0;

  for (const path of paths) {
    churn += lineDelta(before.get(path), after.get(path));
  }

  return churn;
}
