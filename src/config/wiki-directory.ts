import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  LEGACY_OPEN_WIKI_DIR,
  OPEN_WIKI_DIR,
  OPEN_WIKI_VIRTUAL_DIR,
  OPENWIKI_REPOSITORY_CONFIG_FILE,
  OPENWIKI_WIKI_DIR_ENV_KEY,
  PAGE_MANIFEST_FILE,
  UPDATE_METADATA_FILE,
} from "./constants.js";

const MAX_REPOSITORY_CONFIG_BYTES = 16 * 1024;

/**
 * Resolves the repository-relative directory that physically stores a wiki.
 *
 * Explicit configuration wins. Otherwise a new repository uses `wiki/`, while
 * a repository that only has the historical `openwiki/` path keeps using it.
 * The existence check deliberately includes files and symlinks: callers that
 * require a real directory can then fail closed instead of silently selecting a
 * different tree.
 */
export function resolveRepositoryWikiDirectory(
  repositoryRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!path.isAbsolute(repositoryRoot)) {
    throw new Error("Repository wiki resolution requires an absolute root.");
  }

  const configured = env[OPENWIKI_WIKI_DIR_ENV_KEY];
  if (configured !== undefined) {
    return normalizeRepositoryWikiDirectory(configured);
  }

  const repositoryConfigured = readRepositoryWikiDirectory(repositoryRoot);
  if (repositoryConfigured !== undefined) {
    return repositoryConfigured;
  }

  if (pathEntryExists(repositoryRoot, OPEN_WIKI_DIR)) {
    return OPEN_WIKI_DIR;
  }
  if (pathEntryExists(repositoryRoot, LEGACY_OPEN_WIKI_DIR)) {
    return LEGACY_OPEN_WIKI_DIR;
  }
  return OPEN_WIKI_DIR;
}

/**
 * Reads and validates the optional repository-local directory configuration.
 */
function readRepositoryWikiDirectory(
  repositoryRoot: string,
): string | undefined {
  const configPath = path.join(repositoryRoot, OPENWIKI_REPOSITORY_CONFIG_FILE);
  let metadata;
  try {
    metadata = lstatSync(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw invalidRepositoryConfigError(
      "must be a regular file and cannot be a symbolic link",
    );
  }
  if (metadata.size > MAX_REPOSITORY_CONFIG_BYTES) {
    throw invalidRepositoryConfigError(
      `must not exceed ${MAX_REPOSITORY_CONFIG_BYTES} bytes`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw invalidRepositoryConfigError(
      `must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    throw invalidRepositoryConfigError("must contain a JSON object");
  }

  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "wikiDirectory") {
    throw invalidRepositoryConfigError(
      'must contain only the string field "wikiDirectory"',
    );
  }

  const wikiDirectory = (parsed as Record<string, unknown>).wikiDirectory;
  if (typeof wikiDirectory !== "string") {
    throw invalidRepositoryConfigError(
      'field "wikiDirectory" must be a string',
    );
  }
  return normalizeRepositoryWikiDirectory(wikiDirectory);
}

/**
 * Validates and canonicalizes one configured repository-relative directory.
 */
export function normalizeRepositoryWikiDirectory(value: string): string {
  const trimmed = value.trim();
  const slashed = trimmed.replaceAll("\\", "/");

  if (
    trimmed.length === 0 ||
    trimmed.includes("\0") ||
    path.posix.isAbsolute(slashed) ||
    path.win32.isAbsolute(trimmed)
  ) {
    throw invalidWikiDirectoryError();
  }

  const segments = slashed.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9._-]+$/u.test(segment),
    )
  ) {
    throw invalidWikiDirectoryError();
  }

  return segments.join("/");
}

/**
 * Returns the absolute physical wiki root below one repository.
 */
export function repositoryWikiRoot(
  repositoryRoot: string,
  wikiDirectory = resolveRepositoryWikiDirectory(repositoryRoot),
): string {
  const normalized = normalizeRepositoryWikiDirectory(wikiDirectory);
  const root = path.resolve(repositoryRoot);
  const resolved = path.resolve(root, normalized);
  const relative = path.relative(root, resolved);
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw invalidWikiDirectoryError();
  }
  return resolved;
}

/**
 * Maps a stable `/openwiki/...` virtual path to the physical repository path.
 */
export function toRepositoryWikiPath(
  virtualPath: string,
  wikiDirectory: string,
): string {
  const prefix = `/${OPEN_WIKI_VIRTUAL_DIR}/`;
  if (!virtualPath.startsWith(prefix)) {
    throw new Error(`Expected a path below ${prefix}: ${virtualPath}`);
  }
  return `${normalizeRepositoryWikiDirectory(wikiDirectory)}/${virtualPath.slice(prefix.length)}`;
}

/**
 * Converts a physical repository wiki path into the stable virtual namespace.
 */
export function toVirtualWikiPath(
  repositoryPath: string,
  wikiDirectory: string,
): string {
  const normalizedDirectory = normalizeRepositoryWikiDirectory(wikiDirectory);
  const normalizedPath = repositoryPath
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+/, "");
  const prefix = `${normalizedDirectory}/`;
  if (!normalizedPath.startsWith(prefix)) {
    throw new Error(
      `Expected a path below ${normalizedDirectory}/: ${repositoryPath}`,
    );
  }
  return `/${OPEN_WIKI_VIRTUAL_DIR}/${normalizedPath.slice(prefix.length)}`;
}

export function repositoryPageManifestPath(wikiDirectory: string): string {
  return `${normalizeRepositoryWikiDirectory(wikiDirectory)}/${PAGE_MANIFEST_FILE}`;
}

export function repositoryUpdateMetadataPath(wikiDirectory: string): string {
  return `${normalizeRepositoryWikiDirectory(wikiDirectory)}/${UPDATE_METADATA_FILE}`;
}

function pathEntryExists(
  repositoryRoot: string,
  relativePath: string,
): boolean {
  try {
    lstatSync(path.join(repositoryRoot, relativePath));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function invalidWikiDirectoryError(): Error {
  return new Error(
    `${OPENWIKI_WIKI_DIR_ENV_KEY} must be a non-empty repository-relative directory ` +
      'using letters, numbers, ".", "_", or "-" in each path segment.',
  );
}

function invalidRepositoryConfigError(detail: string): Error {
  return new Error(`${OPENWIKI_REPOSITORY_CONFIG_FILE} ${detail}.`);
}
