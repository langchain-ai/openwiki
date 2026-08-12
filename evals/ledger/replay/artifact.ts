import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { WorktreeSafetyError } from "../core/errors.js";
import { assertContained, wikiDirFor } from "../core/paths.js";
import type { KnowledgeArtifact, KnowledgeDocument } from "../core/types.js";

/**
 * Recursively collect the knowledge documents under a wiki directory, sorted by
 * relative path, skipping dot-files and dot-directories. A missing wiki
 * directory yields an empty list rather than throwing, so the runner can decide
 * how to treat an empty run.
 *
 * @param wikiDir - Absolute path to the `openwiki/` directory.
 *
 * @returns The documents, sorted by `relativePath`.
 */
async function collectDocuments(wikiDir: string): Promise<KnowledgeDocument[]> {
  const documents: KnowledgeDocument[] = [];

  async function walk(absDir: string, relDir: string): Promise<void> {
    let entries;

    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of sorted) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await walk(path.join(absDir, entry.name), rel);
      } else if (entry.isFile()) {
        const content = await readFile(path.join(absDir, entry.name), "utf8");
        documents.push({ relativePath: rel, content });
      }
    }
  }

  await walk(wikiDir, "");

  return documents.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/**
 * SHA-256 over the sorted document set. Two artifacts with identical content
 * share a fingerprint, which lets the runner detect a no-op update and lets
 * churn short-circuit.
 *
 * @param documents - The captured documents, already sorted.
 *
 * @returns A hex digest.
 */
function fingerprint(documents: KnowledgeDocument[]): string {
  const hash = createHash("sha256");

  for (const doc of documents) {
    hash.update(doc.relativePath);
    hash.update("\0");
    hash.update(doc.content);
    hash.update("\0");
  }

  return hash.digest("hex");
}

/**
 * Capture the wiki inside a worktree as an immutable artifact: read every
 * knowledge document, write a private copy under the artifacts root, and record
 * a fingerprint. The evaluator consumes the returned immutable document list;
 * the on-disk snapshot remains available for run artifacts and diagnostics.
 *
 * @param checkpointId - The checkpoint this artifact belongs to.
 * @param worktreeDir - Absolute path to the worktree whose wiki to capture.
 * @param artifactsRoot - Absolute path (inside the workspace) to write the
 *   snapshot beneath.
 *
 * @returns The immutable artifact.
 */
export async function captureArtifact(
  checkpointId: string,
  worktreeDir: string,
  artifactsRoot: string,
): Promise<KnowledgeArtifact> {
  const documents = await collectDocuments(wikiDirFor(worktreeDir));
  const snapshotDir = path.join(artifactsRoot, checkpointId);

  // Checkpoint ids originate in benchmark metadata. Validation constrains them
  // to one safe segment, and this realpath guard is defense in depth for direct
  // callers that bypass benchmark loading.
  await assertContained(
    artifactsRoot,
    snapshotDir,
    (resolved, root) =>
      new WorktreeSafetyError(
        `Refusing to write checkpoint artifact outside "${root}": "${resolved}".`,
      ),
  );

  for (const doc of documents) {
    const destination = path.join(snapshotDir, doc.relativePath);

    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, doc.content, "utf8");
  }

  // Ensure the snapshot directory exists even when the run produced nothing, so
  // the evaluator backend always has a real directory to root itself at.
  await mkdir(snapshotDir, { recursive: true });

  return {
    checkpointId,
    snapshotDir,
    fingerprint: fingerprint(documents),
    documents,
  };
}
