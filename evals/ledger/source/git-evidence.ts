import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
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
 * Read a regular file through one stable descriptor without following a final
 * symlink. Inspecting and reading the same open handle avoids a check/use race
 * where the path could be replaced after metadata validation.
 *
 * @param filePath - Absolute tracked-file path to inspect.
 *
 * @returns File bytes, or undefined when the path is not a regular file.
 */
async function readRegularFile(filePath: string): Promise<Buffer | undefined> {
  const noFollowFlag =
    typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let fileHandle;

  try {
    fileHandle = await open(filePath, fsConstants.O_RDONLY | noFollowFlag);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      return undefined;
    }

    throw error;
  }

  try {
    const [openedMetadata, pathMetadata] = await Promise.all([
      fileHandle.stat(),
      lstat(filePath),
    ]);

    if (
      !openedMetadata.isFile() ||
      !pathMetadata.isFile() ||
      pathMetadata.isSymbolicLink() ||
      openedMetadata.dev !== pathMetadata.dev ||
      openedMetadata.ino !== pathMetadata.ino
    ) {
      return undefined;
    }

    return await fileHandle.readFile();
  } finally {
    await fileHandle.close();
  }
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

    const buffer = await readRegularFile(absolutePath);

    if (!buffer || buffer.includes(0)) {
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
