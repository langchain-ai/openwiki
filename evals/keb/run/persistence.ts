import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { WorktreeSafetyError } from "../core/errors.js";
import { isContainedBy } from "../core/paths.js";
import type { KebRunResult } from "../core/types.js";

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
 * Persist a run result as `result.json` in a per-run subdirectory beneath the
 * results directory. Nothing secret is written: the result contains only scores,
 * metadata, and model ids, never API keys.
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
  result: KebRunResult,
): Promise<string> {
  const base = path.resolve(resultsDir);
  const runDir = path.join(
    base,
    `${nameSlug(result.metadata.benchmarkName)}-${timestampSlug(result.metadata.startedAt)}`,
  );

  if (!isContainedBy(base, path.resolve(runDir))) {
    throw new WorktreeSafetyError(
      `Refusing to write run results outside "${base}": "${runDir}".`,
    );
  }

  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );

  return runDir;
}
