import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isExpectedSnapshotRaceError,
  isFileNotFoundError,
} from "../../fs-errors.js";
import { OKF_RESERVED_FILENAMES } from "./taxonomy.js";
import type { Dirent } from "node:fs";

/**
 * Returns all `.md` paths under `root`, bundle-relative and sorted.
 */
export async function collectMarkdownFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  await walkMarkdown(root, "", results);
  return results.sort((a, b) => a.localeCompare(b));
}

/**
 * Recursively collects `.md` files, race/missing tolerant, confined to root.
 */
async function walkMarkdown(
  directory: string,
  relativeDirectory: string,
  results: string[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isExpectedSnapshotRaceError(error) || isFileNotFoundError(error)) {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const rel = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    if (entry.isDirectory()) {
      await walkMarkdown(absolutePath, rel, results);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(rel);
    }
  }
}

/**
 * Atomic write: temp file in the same directory, then rename over the target.
 */
export async function writeFileAtomic(
  absolutePath: string,
  content: string,
): Promise<void> {
  const directory = path.dirname(absolutePath);
  await mkdir(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.${path.basename(absolutePath)}.okf-tmp`,
  );
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, absolutePath);
}

/**
 * Atomically writes only when content differs; returns whether it wrote.
 */
export async function writeIfDifferent(
  absolutePath: string,
  previous: string | null,
  next: string,
): Promise<boolean> {
  if (previous === next) {
    return false;
  }
  await writeFileAtomic(absolutePath, next);
  return true;
}

/**
 * Reads a file, returning null for missing files or mid-scan races.
 */
export async function readFileOrNull(
  absolutePath: string,
): Promise<string | null> {
  try {
    return await readFile(absolutePath, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error) || isExpectedSnapshotRaceError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * True when the path's basename is an OKF reserved filename.
 */
export function isReservedFile(relativePath: string): boolean {
  return (OKF_RESERVED_FILENAMES as readonly string[]).includes(
    path.basename(relativePath),
  );
}
