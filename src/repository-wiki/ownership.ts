import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import {
  normalizeRepositoryWikiDirectory,
  resolveRepositoryWikiRoot,
} from "./paths.js";

const REPOSITORY_WIKI_INSTRUCTIONS_FILE = "INSTRUCTIONS.md";
const MANAGED_FILE_MARKERS = new Set([
  ".last-update.json",
  ".page-manifest.json",
  ".run.json",
]);
const MANAGED_DIRECTORY_MARKERS = new Set([".claims"]);

/**
 * Read-only ownership classification for one proposed repository wiki root.
 */
export type RepositoryWikiOwnership =
  | { status: "absent" }
  | { status: "empty" }
  | { status: "instructions-only" }
  | { status: "managed"; markers: string[] }
  | { status: "unmanaged"; entryCount: number }
  | { status: "unsafe"; reason: string };

/**
 * Inspects a proposed wiki root without writing, moving, or deleting content.
 */
export async function inspectRepositoryWikiOwnership(
  repositoryRoot: string,
  wikiDirectory: string,
): Promise<RepositoryWikiOwnership> {
  const directory = normalizeRepositoryWikiDirectory(wikiDirectory);
  const wikiRoot = resolveRepositoryWikiRoot(repositoryRoot, directory);
  const pathSafety = await inspectPathComponents(repositoryRoot, directory);
  if (pathSafety) return pathSafety;

  let entries;
  try {
    entries = await readdir(wikiRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) return { status: "absent" };
    throw error;
  }

  if (entries.length === 0) return { status: "empty" };

  if (
    entries.length === 1 &&
    entries[0]?.name === REPOSITORY_WIKI_INSTRUCTIONS_FILE
  ) {
    const instructions = await lstat(
      path.join(wikiRoot, REPOSITORY_WIKI_INSTRUCTIONS_FILE),
    );
    return instructions.isFile() && !instructions.isSymbolicLink()
      ? { status: "instructions-only" }
      : {
          status: "unsafe",
          reason: `${REPOSITORY_WIKI_INSTRUCTIONS_FILE} must be a regular file and cannot be a symbolic link`,
        };
  }

  const markers: string[] = [];
  for (const entry of entries) {
    if (
      !MANAGED_FILE_MARKERS.has(entry.name) &&
      !MANAGED_DIRECTORY_MARKERS.has(entry.name)
    ) {
      continue;
    }

    if (entry.isSymbolicLink()) {
      return {
        status: "unsafe",
        reason: `OpenWiki ownership marker ${entry.name} cannot be a symbolic link`,
      };
    }
    if (
      (MANAGED_FILE_MARKERS.has(entry.name) && !entry.isFile()) ||
      (MANAGED_DIRECTORY_MARKERS.has(entry.name) && !entry.isDirectory())
    ) {
      return {
        status: "unsafe",
        reason: `OpenWiki ownership marker ${entry.name} has an unexpected file type`,
      };
    }
    markers.push(entry.name);
  }

  return markers.length > 0
    ? { status: "managed", markers: markers.sort() }
    : { status: "unmanaged", entryCount: entries.length };
}

async function inspectPathComponents(
  repositoryRoot: string,
  wikiDirectory: string,
): Promise<Extract<RepositoryWikiOwnership, { status: "unsafe" }> | null> {
  let current = path.resolve(repositoryRoot);
  const segments = wikiDirectory.split("/");

  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index] ?? "");
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }

    if (metadata.isSymbolicLink()) {
      return {
        status: "unsafe",
        reason: "Repository wiki path components cannot be symbolic links",
      };
    }
    if (!metadata.isDirectory()) {
      return {
        status: "unsafe",
        reason:
          index === segments.length - 1
            ? "Repository wiki target must be a directory"
            : "Repository wiki parent path must be a directory",
      };
    }
  }
  return null;
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
