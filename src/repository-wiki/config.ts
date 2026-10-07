import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { writeTextAtomic } from "../integrations/install/atomic-file.js";
import {
  DEFAULT_REPOSITORY_WIKI_DIRECTORY,
  normalizeRepositoryWikiDirectory,
  RepositoryWikiPathError,
  resolveRepositoryWikiRoot,
} from "./paths.js";

/**
 * Repository-root configuration file for a custom wiki directory.
 */
export const REPOSITORY_WIKI_CONFIG_FILE = ".openwiki.json";

const MAX_REPOSITORY_WIKI_CONFIG_BYTES = 16 * 1024;

/**
 * Persisted repository wiki configuration.
 */
export interface RepositoryWikiConfig {
  /**
   * Slash-normalized repository-relative wiki directory.
   */
  wikiDirectory: string;
}

/**
 * Resolved physical location shared by one repository run.
 */
export interface RepositoryWikiLocation {
  /**
   * Slash-normalized repository-relative directory.
   */
  directory: string;

  /**
   * Absolute contained filesystem root for the repository wiki.
   */
  root: string;

  /**
   * How the directory was selected.
   */
  source: "config" | "default" | "option";
}

/**
 * Error raised for malformed or conflicting repository wiki configuration.
 */
export class RepositoryWikiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryWikiConfigError";
  }
}

/**
 * Reads and validates optional repository-root wiki configuration.
 */
export async function readRepositoryWikiConfig(
  repositoryRoot: string,
): Promise<RepositoryWikiConfig | null> {
  const configPath = repositoryConfigPath(repositoryRoot);
  let handle;
  try {
    handle = await open(
      configPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    if (isMissingFileError(error)) return null;
    if (isSymbolicLinkError(error)) {
      throw configError("cannot be a symbolic link");
    }
    throw error;
  }

  try {
    const openedMetadata = await handle.stat();
    const confirmedMetadata = await lstat(configPath);
    if (!openedMetadata.isFile()) {
      throw configError("must be a regular file");
    }
    if (confirmedMetadata.isSymbolicLink()) {
      throw configError("cannot be a symbolic link");
    }
    if (
      !confirmedMetadata.isFile() ||
      !sameFileIdentity(openedMetadata, confirmedMetadata)
    ) {
      throw configError("must remain a regular file while being read");
    }
    if (openedMetadata.size > MAX_REPOSITORY_WIKI_CONFIG_BYTES) {
      throw configError(
        `must not exceed ${MAX_REPOSITORY_WIKI_CONFIG_BYTES} bytes`,
      );
    }
    const buffer = Buffer.alloc(MAX_REPOSITORY_WIKI_CONFIG_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead > MAX_REPOSITORY_WIKI_CONFIG_BYTES) {
      throw configError(
        `must not exceed ${MAX_REPOSITORY_WIKI_CONFIG_BYTES} bytes`,
      );
    }
    return parseRepositoryWikiConfig(buffer.toString("utf8", 0, bytesRead));
  } finally {
    await handle.close();
  }
}

/**
 * Resolves config, an optional explicit selection, or the default directory.
 */
export async function resolveRepositoryWikiLocation(
  repositoryRoot: string,
  requestedDirectory?: string | null,
): Promise<RepositoryWikiLocation> {
  const configured = await readRepositoryWikiConfig(repositoryRoot);
  const requested =
    requestedDirectory === undefined || requestedDirectory === null
      ? null
      : normalizeRepositoryWikiDirectory(requestedDirectory);

  if (configured && requested && configured.wikiDirectory !== requested) {
    throw new RepositoryWikiConfigError(
      `${REPOSITORY_WIKI_CONFIG_FILE} selects ${JSON.stringify(configured.wikiDirectory)}, but --wiki-dir selected ${JSON.stringify(requested)}. Moving a repository wiki is not supported.`,
    );
  }

  const directory =
    configured?.wikiDirectory ?? requested ?? DEFAULT_REPOSITORY_WIKI_DIRECTORY;
  const source = configured ? "config" : requested ? "option" : "default";

  return {
    directory,
    root: resolveRepositoryWikiRoot(repositoryRoot, directory),
    source,
  };
}

/**
 * Atomically saves a durable custom repository wiki selection.
 */
export async function persistRepositoryWikiConfig(
  repositoryRoot: string,
  wikiDirectory: string,
): Promise<void> {
  const directory = normalizeRepositoryWikiDirectory(wikiDirectory);
  const existing = await readRepositoryWikiConfig(repositoryRoot);

  if (!existing && directory === DEFAULT_REPOSITORY_WIKI_DIRECTORY) {
    return;
  }

  await writeTextAtomic(
    repositoryConfigPath(repositoryRoot),
    `${JSON.stringify({ wikiDirectory: directory }, null, 2)}\n`,
  );
}

function parseRepositoryWikiConfig(content: string): RepositoryWikiConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw configError(
      `must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    throw configError("must contain a JSON object");
  }

  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "wikiDirectory") {
    throw configError('must contain only the string field "wikiDirectory"');
  }

  const value = (parsed as Record<string, unknown>).wikiDirectory;
  if (typeof value !== "string") {
    throw configError('field "wikiDirectory" must be a string');
  }

  try {
    return { wikiDirectory: normalizeRepositoryWikiDirectory(value) };
  } catch (error) {
    if (error instanceof RepositoryWikiPathError) {
      throw configError(error.message);
    }
    throw error;
  }
}

function repositoryConfigPath(repositoryRoot: string): string {
  if (!path.isAbsolute(repositoryRoot)) {
    throw new RepositoryWikiConfigError(
      "Repository wiki configuration requires an absolute repository root.",
    );
  }
  return path.join(path.resolve(repositoryRoot), REPOSITORY_WIKI_CONFIG_FILE);
}

function configError(reason: string): RepositoryWikiConfigError {
  return new RepositoryWikiConfigError(
    `Invalid ${REPOSITORY_WIKI_CONFIG_FILE}: ${reason}.`,
  );
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isSymbolicLinkError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ELOOP";
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  if (left.ino === 0 || right.ino === 0) return true;
  return left.dev === right.dev && left.ino === right.ino;
}
