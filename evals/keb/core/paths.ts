import path from "node:path";

/**
 * Directory name OpenWiki writes its generated wiki into, relative to the
 * repository root. Mirrors `OPEN_WIKI_DIR` in `src/config/constants.ts`. Pinned
 * here so the eval has no build-time coupling to that module for a value that is
 * fixed by OpenWiki's on-disk contract.
 */
export const OPEN_WIKI_DIR = "openwiki";

/**
 * File OpenWiki writes after a run to record the last update. KEB reads it only
 * for diagnostics; change-detection is owned by OpenWiki itself.
 */
export const UPDATE_METADATA_FILE = ".last-update.json";

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
 * segment-aware, never a raw string-prefix test: `/tmp/keb-a` is not treated as
 * inside `/tmp/keb`, and, conversely, an entry whose name merely begins with `..`
 * (for example `/tmp/keb/..cache`) is correctly treated as inside `root` rather
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
