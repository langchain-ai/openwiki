import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { WorktreeSafetyError } from "../core/errors.js";
import { isContainedBy } from "../core/paths.js";
import type {
  EvidenceCorpus,
  LedgerRunResult,
  KnowledgeArtifact,
} from "../core/types.js";
import type { PrecisionAssertionInventory } from "../evaluator/precision.js";

/**
 * Turn an ISO timestamp into a filesystem-safe slug.
 *
 * @param iso - An ISO-8601 timestamp.
 *
 * @returns The timestamp with characters unsafe for a path replaced by dashes.
 */
function timestampSlug(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

/**
 * Collapse a benchmark name into a single safe path segment. The name comes from
 * benchmark JSON and is otherwise unvalidated, so it is untrusted input on a
 * write path: any run of characters outside `[A-Za-z0-9._-]` (which includes both
 * path separators and the `..` that a traversal would need) becomes a single
 * dash, leading and trailing dashes are trimmed, and an empty result falls back to
 * `"benchmark"`. The result can never contain a separator, so it cannot climb out
 * of the results directory.
 *
 * @param name - The benchmark name to sanitize.
 *
 * @returns A non-empty single-segment slug safe to use as a directory name.
 */
function nameSlug(name: string): string {
  const slug = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

  return slug === "" ? "benchmark" : slug;
}

/**
 * Resolve and confine the stable per-run directory shared by incremental audit
 * artifacts and the final result.
 *
 * @param resultsDir - Absolute or relative results root.
 * @param benchmarkName - Untrusted benchmark display name.
 * @param startedAt - ISO timestamp identifying the run.
 *
 * @returns Absolute confined run directory.
 *
 * @throws WorktreeSafetyError when the resolved path escapes the results root.
 */
function runDirectory(
  resultsDir: string,
  benchmarkName: string,
  startedAt: string,
): string {
  const base = path.resolve(resultsDir);
  const runDir = path.join(
    base,
    `${nameSlug(benchmarkName)}-${timestampSlug(startedAt)}`,
  );

  if (!isContainedBy(base, path.resolve(runDir))) {
    throw new WorktreeSafetyError(
      `Refusing to write run results outside "${base}": "${runDir}".`,
    );
  }

  return runDir;
}

/**
 * Create the stable per-run directory before benchmark execution begins.
 *
 * @param resultsDir - Results root.
 * @param benchmarkName - Benchmark name used in the directory slug.
 * @param startedAt - Run start timestamp.
 *
 * @returns Absolute created run directory.
 */
export async function prepareRunDirectory(
  resultsDir: string,
  benchmarkName: string,
  startedAt: string,
): Promise<string> {
  const runDir = runDirectory(resultsDir, benchmarkName, startedAt);
  await mkdir(runDir, { recursive: true });
  return runDir;
}

/**
 * Persist one complete pre-judgment assertion inventory immediately so it
 * survives a later evaluator or benchmark failure.
 *
 * @param runDir - Prepared confined run directory.
 * @param inventory - Complete checkpoint extraction inventory.
 *
 * @returns Nothing after the inventory is durable.
 */
export async function writeAssertionInventory(
  runDir: string,
  inventory: PrecisionAssertionInventory,
): Promise<void> {
  const checkpointSlug = nameSlug(inventory.checkpointId);
  const assertionsDir = path.join(runDir, "assertions");
  await mkdir(assertionsDir, { recursive: true });
  await writeFile(
    path.join(assertionsDir, `${checkpointSlug}.json`),
    `${JSON.stringify(inventory, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Persist normalized checkpoint source evidence before evaluation so precision
 * citations remain auditable after the temporary replay workspace is removed.
 *
 * @param runDir - Prepared confined run directory.
 * @param evidence - Complete normalized checkpoint evidence.
 *
 * @returns Nothing after the evidence is durable.
 */
export async function writeEvidenceCorpus(
  runDir: string,
  evidence: EvidenceCorpus,
): Promise<void> {
  const checkpointSlug = nameSlug(evidence.checkpointId);
  const evidenceDir = path.join(runDir, "evidence");
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(
    path.join(evidenceDir, `${checkpointSlug}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Persist one complete generated-wiki artifact before evaluation begins. The
 * snapshot includes both directly readable Markdown files and a manifest with
 * the checkpoint fingerprint and exact document inventory.
 *
 * @param runDir - Prepared confined run directory.
 * @param artifact - Immutable checkpoint artifact to preserve.
 *
 * @returns Nothing after every document and the manifest are durable.
 *
 * @throws WorktreeSafetyError when a document path would escape its checkpoint
 * artifact directory.
 */
export async function writeArtifactSnapshot(
  runDir: string,
  artifact: KnowledgeArtifact,
): Promise<void> {
  const checkpointSlug = nameSlug(artifact.checkpointId);
  const checkpointDir = path.join(runDir, "artifacts", checkpointSlug);
  await mkdir(checkpointDir, { recursive: true });

  for (const document of artifact.documents) {
    const destination = path.resolve(checkpointDir, document.relativePath);

    if (!isContainedBy(checkpointDir, destination)) {
      throw new WorktreeSafetyError(
        `Refusing to write artifact document outside "${checkpointDir}": "${document.relativePath}".`,
      );
    }

    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, document.content, "utf8");
  }

  await writeFile(
    path.join(runDir, "artifacts", `${checkpointSlug}.json`),
    `${JSON.stringify(
      {
        checkpointId: artifact.checkpointId,
        fingerprint: artifact.fingerprint,
        documents: artifact.documents.map((document) => document.relativePath),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

/**
 * Persist bounded failure metadata beside any assertion inventories that were
 * already written for an incomplete run.
 *
 * @param runDir - Prepared confined run directory.
 * @param error - Failure raised by benchmark execution.
 *
 * @returns Nothing after failure metadata is durable.
 */
export async function writeRunFailure(
  runDir: string,
  error: unknown,
): Promise<void> {
  const normalized =
    error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { name: "Error", message: String(error) };
  await writeFile(
    path.join(runDir, "error.json"),
    `${JSON.stringify(normalized, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Constant basename for the unverified-claims worklist. It is a fixed literal,
 * never derived from untrusted input, so the write target can only ever be this
 * one file directly inside the confined run directory.
 */
const UNVERIFIED_CLAIMS_BASENAME = "unverified-claims.md";

/**
 * Persist the human-readable worklist of claims the source evidence could neither
 * support nor refute. They remain visible in the shared-denominator claim state;
 * this file gives a reader the concrete assertions and a clear next action
 * (review each for a hidden hallucination or a gap in source evidence). It is
 * written with a constant basename
 * directly inside the already confined run directory, so no untrusted input
 * reaches the write path.
 *
 * @param runDir - Prepared confined run directory.
 * @param result - The completed run result.
 *
 * @returns Absolute path to the written worklist, or undefined when the run had
 *   no unverified claims and nothing was written.
 */
export async function writeUnverifiedClaims(
  runDir: string,
  result: LedgerRunResult,
): Promise<string | undefined> {
  const sections: string[] = [];
  let total = 0;

  for (const checkpoint of result.checkpoints) {
    const unverified = (
      checkpoint.evaluations?.precisionEvaluations ?? []
    ).filter(
      (claim) => claim.tense === "current" && claim.verdict === "unverified",
    );
    if (unverified.length === 0) {
      continue;
    }

    total += unverified.length;
    const items = unverified.map(
      (claim) =>
        `- "${claim.assertion}"\n  - Location: ${claim.location}\n  - Why unverified: ${claim.rationale}`,
    );
    sections.push(`## ${checkpoint.checkpointId}\n\n${items.join("\n")}`);
  }

  if (total === 0) {
    return undefined;
  }

  const body = [
    "# Unverified claims",
    "",
    `${result.metadata.benchmarkName} · ${result.metadata.startedAt}`,
    "",
    "These claims are neither supported nor refuted by the source evidence.",
    "Read each one: a claim the source cannot",
    "confirm is either a hidden hallucination or a gap in the evidence retrieved",
    "from source at this checkpoint.",
    "",
    sections.join("\n\n"),
    "",
  ].join("\n");

  const destination = path.join(runDir, UNVERIFIED_CLAIMS_BASENAME);
  await writeFile(destination, body, "utf8");

  return destination;
}

/**
 * Persist a run result as `result.json` in a per-run subdirectory beneath the
 * results directory. Nothing secret is written: the result contains only claim
 * measurements, metadata, and model ids, never API keys.
 *
 * The per-run directory name is `<name-slug>-<timestamp-slug>`, where the name is
 * sanitized to a single safe path segment. As defense in depth beyond that
 * sanitizing, the resolved run directory is asserted to sit inside the resolved
 * results directory before anything is written, so a write can never escape it.
 *
 * @param resultsDir - Absolute path to the results directory.
 * @param result - The run result to persist.
 *
 * @returns Absolute path to the directory the result was written in.
 *
 * @throws WorktreeSafetyError if the resolved run directory would fall outside the
 *   results directory.
 */
export async function writeRunResult(
  resultsDir: string,
  result: LedgerRunResult,
): Promise<string> {
  const runDir = await prepareRunDirectory(
    resultsDir,
    result.metadata.benchmarkName,
    result.metadata.startedAt,
  );
  await writeFile(
    path.join(runDir, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );

  return runDir;
}
