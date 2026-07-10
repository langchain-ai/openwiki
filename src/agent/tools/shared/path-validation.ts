import { realpath } from "node:fs/promises";
import path from "node:path";
import { isFileNotFoundError } from "../../../fs-errors.js";

/**
 * Resolves a virtual (repository-relative) path against a root directory while
 * rejecting traversal attempts. Virtual paths use "/" separators and are always
 * treated as relative to `rootDir`, even when they begin with a leading slash.
 *
 * Rejects `~`, `..` segments, and any path that resolves outside `rootDir`.
 */
export function resolveWithinRoot(
  virtualPath: string,
  rootDir: string,
): string {
  if (typeof virtualPath !== "string" || virtualPath.trim().length === 0) {
    throw new Error("Path must be a non-empty string.");
  }

  if (virtualPath.includes("~")) {
    throw new Error(`Path may not contain '~': ${virtualPath}`);
  }

  const segments = virtualPath
    .split(/[\\/]+/u)
    .filter((segment) => segment.length > 0);

  if (segments.includes("..")) {
    throw new Error(`Path may not contain '..': ${virtualPath}`);
  }

  const resolvedRoot = path.resolve(rootDir);
  const resolved = path.resolve(resolvedRoot, ...segments);

  if (
    resolved !== resolvedRoot &&
    !resolved.startsWith(resolvedRoot + path.sep)
  ) {
    throw new Error(`Path escapes the repository root: ${virtualPath}`);
  }

  return resolved;
}

/**
 * Like {@link resolveWithinRoot}, but also follows symlinks with `fs.realpath`
 * and verifies the real path still lives inside the real root directory.
 * Paths that do not exist yet pass the symlink check (nothing to follow).
 */
export async function resolveRealPathWithinRoot(
  virtualPath: string,
  rootDir: string,
): Promise<string> {
  const resolved = resolveWithinRoot(virtualPath, rootDir);
  const realRoot = await realpath(path.resolve(rootDir));

  let realResolved: string;

  try {
    realResolved = await realpath(resolved);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return resolved;
    }

    throw error;
  }

  if (
    realResolved !== realRoot &&
    !realResolved.startsWith(realRoot + path.sep)
  ) {
    throw new Error(
      `Path resolves outside the repository root via symlink: ${virtualPath}`,
    );
  }

  return resolved;
}

/**
 * Accepts only safe git refs: hex object names (4-40 chars) and a narrow set of
 * HEAD-relative forms. Rejects branch names, option-like strings, and anything
 * that could be interpreted as a flag or shell metacharacter.
 */
export function isSafeGitRef(ref: string): boolean {
  if (typeof ref !== "string") {
    return false;
  }

  return (
    /^[a-f0-9]{4,40}$/u.test(ref) ||
    /^HEAD(~\d+)?$/u.test(ref) ||
    /^HEAD\^\d+$/u.test(ref)
  );
}

/**
 * Validates a virtual path and returns the repository-relative pathspec (with
 * POSIX separators) suitable for passing to git after `--`.
 */
export function validateVirtualPath(
  virtualPath: string,
  rootDir: string,
): string {
  const resolved = resolveWithinRoot(virtualPath, rootDir);
  const relative = path.relative(path.resolve(rootDir), resolved);

  return relative.split(path.sep).join("/");
}
