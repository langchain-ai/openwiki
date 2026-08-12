import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";

import { LedgerError, WorktreeSafetyError } from "../core/errors.js";
import { assertContained, isContainedBy } from "../core/paths.js";
import type {
  EvidenceCorpus,
  LedgerRunResult,
  KnowledgeArtifact,
  KnowledgeDocument,
} from "../core/types.js";

/**
 * The small manifest persisted beside a saved checkpoint artifact.
 */
interface ArtifactManifest {
  /**
   * Checkpoint represented by the snapshot.
   */
  checkpointId: string;

  /**
   * Stable content fingerprint captured during the original run.
   */
  fingerprint: string;

  /**
   * Relative paths of every document in the snapshot.
   */
  documents: string[];
}

/**
 * Parse one saved JSON file and wrap malformed input in an actionable LEDGER error.
 *
 * @param file - Absolute JSON file path.
 * @param label - Human-readable description used in errors.
 *
 * @returns The parsed JSON value.
 *
 * @throws LedgerError when the file cannot be read or parsed.
 */
async function readJson(file: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    throw new LedgerError(
      `Could not read saved ${label} "${file}": ${(error as Error).message}`,
    );
  }
}

/**
 * Narrow an unknown value to a non-null object.
 *
 * @param value - Value to inspect.
 *
 * @returns Whether the value is a plain JSON object candidate.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate the persisted artifact manifest fields used by replay.
 *
 * @param value - Parsed manifest JSON.
 * @param checkpointId - Checkpoint the caller requested.
 *
 * @returns A validated artifact manifest.
 *
 * @throws LedgerError when a required field is absent or inconsistent.
 */
function artifactManifest(
  value: unknown,
  checkpointId: string,
): ArtifactManifest {
  if (
    !isRecord(value) ||
    value.checkpointId !== checkpointId ||
    typeof value.fingerprint !== "string" ||
    !Array.isArray(value.documents) ||
    !value.documents.every((item) => typeof item === "string")
  ) {
    throw new LedgerError(
      `Saved artifact manifest for checkpoint "${checkpointId}" is malformed.`,
    );
  }

  return {
    checkpointId,
    fingerprint: value.fingerprint,
    documents: value.documents,
  };
}

/** Require a saved-run directory to be real, contained, and non-symlinked. */
async function assertSavedDirectory(
  allowedRoot: string,
  directory: string,
  label: string,
): Promise<void> {
  if (!isContainedBy(path.resolve(allowedRoot), path.resolve(directory))) {
    throw new WorktreeSafetyError(
      `Refusing to use saved ${label} outside "${allowedRoot}".`,
    );
  }
  await assertContained(
    allowedRoot,
    directory,
    (resolved, root) =>
      new WorktreeSafetyError(
        `Refusing to use saved ${label} outside "${root}": "${resolved}".`,
      ),
  );
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new WorktreeSafetyError(
      `Refusing to use non-directory or symbolic-link saved ${label} "${directory}".`,
    );
  }
}

/**
 * Read one saved artifact document through a stable regular-file descriptor.
 * Realpath containment rejects symlinked parents that escape the snapshot;
 * O_NOFOLLOW plus descriptor/path inode comparison rejects a final symlink and
 * closes the check/use gap before content is read.
 */
async function readSavedArtifactDocument(
  snapshotDir: string,
  file: string,
  relativePath: string,
): Promise<string> {
  const escapeError = (resolved: string, root: string): WorktreeSafetyError =>
    new WorktreeSafetyError(
      `Refusing to read saved artifact outside "${root}": "${relativePath}" resolved to "${resolved}".`,
    );

  if (!isContainedBy(path.resolve(snapshotDir), path.resolve(file))) {
    throw escapeError(path.resolve(file), path.resolve(snapshotDir));
  }
  const artifactsRoot = path.dirname(snapshotDir);
  await assertContained(artifactsRoot, file, escapeError);
  await assertContained(snapshotDir, file, escapeError);

  const noFollowFlag =
    typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let fileHandle;

  try {
    fileHandle = await open(file, fsConstants.O_RDONLY | noFollowFlag);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new WorktreeSafetyError(
        `Refusing to read symbolic-link artifact document "${relativePath}".`,
      );
    }
    throw error;
  }

  try {
    const [openedMetadata, pathMetadata] = await Promise.all([
      fileHandle.stat(),
      lstat(file),
    ]);
    if (
      !openedMetadata.isFile() ||
      !pathMetadata.isFile() ||
      pathMetadata.isSymbolicLink() ||
      openedMetadata.dev !== pathMetadata.dev ||
      openedMetadata.ino !== pathMetadata.ino
    ) {
      throw new WorktreeSafetyError(
        `Refusing to read non-regular or replaced artifact document "${relativePath}".`,
      );
    }

    // Recheck after opening so a symlinked parent changed during the first check
    // cannot silently redirect the path outside the snapshot.
    await assertContained(artifactsRoot, file, escapeError);
    await assertContained(snapshotDir, file, escapeError);
    return await fileHandle.readFile("utf8");
  } finally {
    await fileHandle.close();
  }
}

/**
 * Load one immutable generated knowledge artifact from a completed LEDGER run.
 * Every manifest path is resolved beneath the checkpoint snapshot directory
 * before it is read.
 *
 * @param runDir - Directory containing saved LEDGER run artifacts.
 * @param checkpointId - Checkpoint artifact to load.
 *
 * @returns The reconstructed immutable artifact.
 *
 * @throws LedgerError when the manifest or a document cannot be read.
 * @throws WorktreeSafetyError when a manifest document escapes its snapshot.
 */
export async function loadSavedArtifact(
  runDir: string,
  checkpointId: string,
): Promise<KnowledgeArtifact> {
  const absoluteRunDir = path.resolve(runDir);
  const artifactsDir = path.join(absoluteRunDir, "artifacts");
  await assertSavedDirectory(
    absoluteRunDir,
    artifactsDir,
    "artifacts directory",
  );
  const manifestFile = path.join(artifactsDir, `${checkpointId}.json`);
  await assertContained(
    artifactsDir,
    manifestFile,
    (resolved, root) =>
      new WorktreeSafetyError(
        `Refusing to read saved artifact manifest outside "${root}": "${resolved}".`,
      ),
  );
  const manifestMetadata = await lstat(manifestFile);
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) {
    throw new WorktreeSafetyError(
      `Refusing to read non-regular or symbolic-link artifact manifest "${manifestFile}".`,
    );
  }
  const manifest = artifactManifest(
    await readJson(manifestFile, "artifact manifest"),
    checkpointId,
  );
  const snapshotDir = path.join(artifactsDir, checkpointId);
  await assertSavedDirectory(artifactsDir, snapshotDir, "artifact snapshot");
  const documents: KnowledgeDocument[] = [];

  for (const relativePath of manifest.documents) {
    const file = path.resolve(snapshotDir, relativePath);

    try {
      documents.push({
        relativePath,
        content: await readSavedArtifactDocument(
          snapshotDir,
          file,
          relativePath,
        ),
      });
    } catch (error) {
      if (error instanceof WorktreeSafetyError) {
        throw error;
      }
      throw new LedgerError(
        `Could not read saved artifact document "${file}": ${(error as Error).message}`,
      );
    }
  }

  return {
    checkpointId,
    snapshotDir,
    fingerprint: manifest.fingerprint,
    documents,
  };
}

/**
 * Load the complete normalized source-evidence corpus saved for a checkpoint.
 *
 * @param runDir - Directory containing saved LEDGER run artifacts.
 * @param checkpointId - Checkpoint evidence to load.
 *
 * @returns The parsed evidence corpus.
 *
 * @throws LedgerError when the corpus is malformed or belongs to another checkpoint.
 */
export async function loadSavedEvidence(
  runDir: string,
  checkpointId: string,
): Promise<EvidenceCorpus> {
  const file = path.join(
    path.resolve(runDir),
    "evidence",
    `${checkpointId}.json`,
  );
  const value = await readJson(file, "evidence corpus");

  if (
    !isRecord(value) ||
    value.checkpointId !== checkpointId ||
    !Array.isArray(value.records) ||
    !value.records.every(
      (record) =>
        isRecord(record) &&
        typeof record.evidenceId === "string" &&
        typeof record.sourceRef === "string" &&
        typeof record.observedAtCheckpoint === "string" &&
        typeof record.current === "boolean" &&
        typeof record.content === "string",
    )
  ) {
    throw new LedgerError(
      `Saved evidence corpus for checkpoint "${checkpointId}" is malformed.`,
    );
  }

  return value as unknown as EvidenceCorpus;
}

/**
 * Load the original completed result whose artifacts are being re-evaluated.
 * Only metadata and execution observations are reused; every semantic verdict
 * and checkpoint measurement is recomputed.
 *
 * @param runDir - Directory containing `result.json`.
 *
 * @returns The saved run result.
 *
 * @throws LedgerError when the result does not have the minimum required shape.
 */
export async function loadSavedRunResult(
  runDir: string,
): Promise<LedgerRunResult> {
  const file = path.join(path.resolve(runDir), "result.json");
  const value = await readJson(file, "run result");

  if (
    !isRecord(value) ||
    !isRecord(value.metadata) ||
    typeof value.metadata.benchmarkName !== "string" ||
    !Array.isArray(value.checkpoints)
  ) {
    throw new LedgerError(`Saved run result "${file}" is malformed.`);
  }

  return value as unknown as LedgerRunResult;
}
