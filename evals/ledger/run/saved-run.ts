import { readFile } from "node:fs/promises";
import path from "node:path";

import { LedgerError, WorktreeSafetyError } from "../core/errors.js";
import { isContainedBy } from "../core/paths.js";
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
  const manifestFile = path.join(
    absoluteRunDir,
    "artifacts",
    `${checkpointId}.json`,
  );
  const manifest = artifactManifest(
    await readJson(manifestFile, "artifact manifest"),
    checkpointId,
  );
  const snapshotDir = path.join(absoluteRunDir, "artifacts", checkpointId);
  const documents: KnowledgeDocument[] = [];

  for (const relativePath of manifest.documents) {
    const file = path.resolve(snapshotDir, relativePath);

    if (!isContainedBy(snapshotDir, file)) {
      throw new WorktreeSafetyError(
        `Refusing to read saved artifact outside "${snapshotDir}": "${relativePath}".`,
      );
    }

    try {
      documents.push({
        relativePath,
        content: await readFile(file, "utf8"),
      });
    } catch (error) {
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
