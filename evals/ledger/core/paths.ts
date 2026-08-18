import { realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Directory name OpenWiki writes its generated wiki into, relative to the
 * repository root. Mirrors `OPEN_WIKI_DIR` in `src/config/constants.ts`. Pinned
 * here so the eval has no build-time coupling to that module for a value that is
 * fixed by OpenWiki's on-disk contract.
 */
export const OPEN_WIKI_DIR = "openwiki";

/**
 * Absolute path to the generated wiki inside a prepared worktree.
 *
 * @param worktreeDir - Absolute path to the checked-out worktree.
 *
 * @returns Absolute path to the `openwiki/` directory within it.
 */
export function wikiDirFor(worktreeDir: string): string {
  return path.join(worktreeDir, OPEN_WIKI_DIR);
}

/**
 * True when `child` is the same path as `root` or strictly inside it. Both
 * arguments must already be absolute and normalized (callers pass realpaths).
 * Used by the destructive-op containment guard, so it is deliberately strict and
 * segment-aware, never a raw string-prefix test: `/tmp/ledger-a` is not treated as
 * inside `/tmp/ledger`, and, conversely, an entry whose name merely begins with `..`
 * (for example `/tmp/ledger/..cache`) is correctly treated as inside `root` rather
 * than as an escape.
 *
 * @param root - Absolute, normalized container path.
 * @param child - Absolute, normalized candidate path.
 *
 * @returns Whether `child` is contained by `root`.
 */
export function isContainedBy(root: string, child: string): boolean {
  const relative = path.relative(root, child);

  if (relative === "") {
    return true;
  }

  // An absolute result means the two paths share no common base (on Windows,
  // different drives), so `child` cannot be inside `root`.
  if (path.isAbsolute(relative)) {
    return false;
  }

  // A leading `..` segment is the only way a normalized relative path climbs out
  // of `root`. Match it as a whole segment (`..` alone, or `..` then a
  // separator), never as a string prefix, so a real child whose name merely
  // starts with `..` is not misread as an escape.
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

/**
 * Resolve `target` to a real path even when it does not exist yet: take its own
 * realpath, or when that fails (the path is a destination about to be created)
 * resolve the parent's realpath and re-attach the basename. This closes a
 * symlinked-parent escape while still resolving a not-yet-created path.
 *
 * @param target - Absolute path to resolve.
 *
 * @returns The realpath-resolved absolute path, following symlinks as far as
 *   they exist on disk.
 */
async function resolveRealPath(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    const parent = await realpath(path.dirname(target));
    return path.join(parent, path.basename(target));
  }
}

/**
 * Assert that `target` resolves to a path contained by `allowedRoot`, following
 * symlinks so neither a symlinked target nor a symlinked parent can escape the
 * root. `target` may not exist yet, so it is resolved via `resolveRealPath`. This
 * is the shared realpath containment guard every destructive filesystem or Git
 * operation in the eval passes through; callers supply the domain error thrown on
 * an escape so each keeps its own error type and message.
 *
 * @param allowedRoot - Absolute path the target must be contained by.
 * @param target - Absolute path to check.
 * @param onEscape - Builds the error to throw, given the resolved target and the resolved root.
 *
 * @throws Whatever `onEscape` returns, when the resolved target escapes the root.
 */
export async function assertContained(
  allowedRoot: string,
  target: string,
  onEscape: (resolvedTarget: string, resolvedRoot: string) => Error,
): Promise<void> {
  const root = await realpath(allowedRoot);
  const resolved = await resolveRealPath(target);

  if (!isContainedBy(root, resolved)) {
    throw onEscape(resolved, root);
  }
}
