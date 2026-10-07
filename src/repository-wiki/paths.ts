import path from "node:path";

/**
 * Repository directory used when no explicit wiki configuration exists.
 */
export const DEFAULT_REPOSITORY_WIKI_DIRECTORY = "openwiki";

/**
 * Error raised when a repository wiki directory or page path is unsafe.
 */
export class RepositoryWikiPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryWikiPathError";
  }
}

/**
 * Validates and slash-normalizes one repository-relative wiki directory.
 */
export function normalizeRepositoryWikiDirectory(value: string): string {
  if (value !== value.trim()) {
    throw invalidDirectoryError(value, "surrounding whitespace is not allowed");
  }

  const slashed = value.replaceAll("\\", "/");
  if (
    slashed.length === 0 ||
    path.posix.isAbsolute(slashed) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw invalidDirectoryError(
      value,
      "use a non-empty repository-relative path",
    );
  }

  if (/\p{Cc}/u.test(slashed)) {
    throw invalidDirectoryError(value, "control characters are not allowed");
  }

  const segments = slashed.split("/");
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment !== segment.trim()
    ) {
      throw invalidDirectoryError(
        value,
        "empty, dot, traversal, and whitespace-padded segments are not allowed",
      );
    }
    if (segment.toLowerCase() === ".git") {
      throw invalidDirectoryError(value, "the .git directory is reserved");
    }
  }

  return segments.join("/");
}

/**
 * Resolves a validated wiki directory beneath one absolute repository root.
 */
export function resolveRepositoryWikiRoot(
  repositoryRoot: string,
  wikiDirectory: string,
): string {
  if (!path.isAbsolute(repositoryRoot)) {
    throw new RepositoryWikiPathError(
      "Repository wiki resolution requires an absolute repository root.",
    );
  }

  const root = path.resolve(repositoryRoot);
  const directory = normalizeRepositoryWikiDirectory(wikiDirectory);
  const resolved = path.resolve(root, ...directory.split("/"));
  const relative = path.relative(root, resolved);

  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new RepositoryWikiPathError(
      "Repository wiki directory must remain below the repository root.",
    );
  }

  return resolved;
}

/**
 * Canonical path operations scoped to one physical repository wiki directory.
 */
export class RepositoryWikiPaths {
  /**
   * Slash-normalized repository-relative directory.
   */
  readonly directory: string;

  /**
   * Root-absolute repository path used by model-facing filesystem tools.
   */
  readonly canonicalRoot: string;

  /**
   * Canonical generated quickstart path.
   */
  readonly quickstartPage: string;

  /**
   * Canonical user-authored repository brief path.
   */
  readonly instructionsPage: string;

  constructor(wikiDirectory: string) {
    this.directory = normalizeRepositoryWikiDirectory(wikiDirectory);
    this.canonicalRoot = `/${this.directory}`;
    this.quickstartPage = `${this.canonicalRoot}/quickstart.md`;
    this.instructionsPage = `${this.canonicalRoot}/INSTRUCTIONS.md`;
  }

  /**
   * Canonicalizes an actual or wiki-relative Markdown page path.
   */
  normalizePage(pageValue: string): string {
    const canonical = this.normalizePath(pageValue);
    if (!canonical.endsWith(".md")) {
      throw new RepositoryWikiPathError(
        `Repository wiki page must be Markdown: ${pageValue}`,
      );
    }
    return canonical;
  }

  /**
   * Canonicalizes an actual or wiki-relative path beneath the wiki root.
   */
  normalizePath(pathValue: string): string {
    const slashed = normalizeCandidate(pathValue);
    const unrooted = slashed.replace(/^\/+/, "");
    if (
      slashed.startsWith("/") &&
      !this.isRepositoryRelativeWikiPath(unrooted)
    ) {
      throw new RepositoryWikiPathError(
        `Root-absolute path must resolve below ${this.canonicalRoot}/: ${pathValue}`,
      );
    }
    const repositoryPath = this.isRepositoryRelativeWikiPath(unrooted)
      ? unrooted
      : `${this.directory}/${unrooted}`;
    const canonical = `/${path.posix.normalize(repositoryPath)}`;

    if (!this.contains(canonical) || canonical === this.canonicalRoot) {
      throw new RepositoryWikiPathError(
        `Path must resolve below ${this.canonicalRoot}/: ${pathValue}`,
      );
    }
    return canonical;
  }

  /**
   * Converts one canonical page to a repository-relative POSIX path.
   */
  toRepositoryPage(pageValue: string): string {
    return this.normalizePage(pageValue).slice(1);
  }

  /**
   * Converts one canonical page to a path relative to the wiki root.
   */
  toWikiRelativePage(pageValue: string): string {
    return this.normalizePage(pageValue).slice(this.canonicalRoot.length + 1);
  }

  /**
   * Tests whether a candidate repository path is the wiki root or a descendant.
   */
  contains(pathValue: string): boolean {
    if (pathValue !== pathValue.trim()) return false;
    const normalized = normalizeRepositoryCandidate(pathValue);
    return (
      normalized === this.canonicalRoot ||
      normalized.startsWith(`${this.canonicalRoot}/`)
    );
  }

  private isRepositoryRelativeWikiPath(pathValue: string): boolean {
    return (
      pathValue === this.directory || pathValue.startsWith(`${this.directory}/`)
    );
  }
}

function normalizeCandidate(value: string): string {
  if (value !== value.trim() || value.length === 0 || /\p{Cc}/u.test(value)) {
    throw new RepositoryWikiPathError(`Invalid repository wiki path: ${value}`);
  }

  const slashed = value.replaceAll("\\", "/");
  if (
    slashed.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new RepositoryWikiPathError(
      `Repository wiki path cannot contain dot or traversal segments: ${value}`,
    );
  }

  const unrooted = slashed.replace(/^\/+/, "");
  if (!unrooted || unrooted.split("/").some((segment) => !segment)) {
    throw new RepositoryWikiPathError(`Invalid repository wiki path: ${value}`);
  }
  return slashed;
}

function normalizeRepositoryCandidate(value: string): string {
  const slashed = value.trim().replaceAll("\\", "/");
  if (
    !slashed ||
    /\p{Cc}/u.test(slashed) ||
    slashed.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return "";
  }
  const normalized = path.posix.normalize(`/${slashed.replace(/^\/+/, "")}`);
  return normalized === "/" ? "" : normalized;
}

function invalidDirectoryError(
  value: string,
  reason: string,
): RepositoryWikiPathError {
  return new RepositoryWikiPathError(
    `Invalid repository wiki directory ${JSON.stringify(value)}: ${reason}.`,
  );
}
