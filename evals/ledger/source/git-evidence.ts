import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { EvaluationError } from "../core/errors.js";
import { compareStrings } from "../core/order.js";
import { isContainedBy } from "../core/paths.js";
import type { EvidenceCorpus, EvidenceRecord } from "../core/types.js";
import { git } from "../replay/git.js";

/**
 * Maximum characters retained per evidence chunk before splitting.
 */
const MAX_EVIDENCE_CHARS = 6_000;

/**
 * Split text into stable bounded chunks, preferring newline boundaries without
 * dropping any source content.
 *
 * @param content - Complete UTF-8 source content.
 *
 * @returns Non-empty chunks in source order.
 */
function chunkContent(content: string): string[] {
  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > MAX_EVIDENCE_CHARS) {
    const candidate = remaining.slice(0, MAX_EVIDENCE_CHARS);
    const newline = candidate.lastIndexOf("\n");
    const boundary =
      newline > MAX_EVIDENCE_CHARS / 2 ? newline + 1 : MAX_EVIDENCE_CHARS;
    chunks.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

/**
 * Format a stable zero-padded evidence ordinal.
 *
 * @param ordinal - Zero-based chunk position.
 *
 * @returns Four-digit decimal ordinal.
 */
function formatOrdinal(ordinal: number): string {
  return ordinal.toString().padStart(4, "0");
}

/**
 * Collect a checkpoint's tracked Git files as deterministic source evidence.
 * Binary files and the generated `openwiki/` artifact directory are excluded.
 *
 * @param checkpointId - Active checkpoint identifier.
 * @param worktreeDir - Checked-out Git worktree containing the source truth.
 *
 * @returns Immutable evidence corpus in stable path and chunk order.
 */
export async function collectGitEvidence(
  checkpointId: string,
  worktreeDir: string,
): Promise<EvidenceCorpus> {
  const output = await git(worktreeDir, ["ls-files", "-z"]);
  const relativePaths = output
    .split("\0")
    .filter((relativePath) => relativePath.length > 0)
    .filter(
      (relativePath) =>
        relativePath !== "openwiki" && !relativePath.startsWith("openwiki/"),
    )
    .sort(compareStrings);
  const records: EvidenceRecord[] = [];
  const workspaceRoot = path.resolve(worktreeDir);

  records.push({
    evidenceId: "git:tracked-files",
    sourceRef: "git tracked files",
    observedAtCheckpoint: checkpointId,
    current: true,
    content: [
      `Tracked files reported by git ls-files at checkpoint ${checkpointId}:`,
      ...relativePaths.map((relativePath) => `- ${relativePath}`),
    ].join("\n"),
  });

  for (const relativePath of relativePaths) {
    const absolutePath = path.resolve(workspaceRoot, relativePath);

    if (!isContainedBy(workspaceRoot, absolutePath)) {
      throw new EvaluationError(
        `Git evidence path escapes the replay workspace: "${relativePath}".`,
      );
    }

    const metadata = await lstat(absolutePath);

    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      continue;
    }

    const buffer = await readFile(absolutePath);

    if (buffer.includes(0)) {
      continue;
    }

    const chunks = chunkContent(buffer.toString("utf8"));

    chunks.forEach((content, ordinal) => {
      records.push({
        evidenceId: `${relativePath}::${formatOrdinal(ordinal)}`,
        sourceRef: relativePath,
        observedAtCheckpoint: checkpointId,
        current: true,
        content,
      });
    });
  }

  return { checkpointId, records };
}
