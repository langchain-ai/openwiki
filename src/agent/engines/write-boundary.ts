import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { OPEN_WIKI_DIR } from "../../constants.js";

/**
 * Filesystem write policy for agent-CLI runs.
 * - `docs-only`: only paths under openwiki/ plus root agent instruction files may change.
 * - `none`: no post-run path check (chat, or local-wiki where cwd is already the wiki root).
 */
export type AgentCliWriteBoundary = "docs-only" | "none";

const IGNORED_DIR_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".jj",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  ".idea",
  ".vscode",
]);

/**
 * Relative paths allowed under a docs-only write boundary for repository
 * init/update runs. Matches the agent-CLI system prompt (openwiki/ plus the
 * OpenWiki blocks in top-level agent instruction files).
 */
export function isAllowedDocsOnlyWritePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/gu, "/").replace(/^\.\/+/u, "");

  if (
    normalized === OPEN_WIKI_DIR ||
    normalized.startsWith(`${OPEN_WIKI_DIR}/`)
  ) {
    return true;
  }

  return normalized === "AGENTS.md" || normalized === "CLAUDE.md";
}

/**
 * Lists files under `rootDir` whose mtime is at or after `sinceMs`.
 * Skips heavy/irrelevant directories. Paths are returned relative to `rootDir`
 * with forward slashes.
 */
export async function listFilesModifiedSince(
  rootDir: string,
  sinceMs: number,
): Promise<string[]> {
  const results: string[] = [];
  const stack: string[] = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();

    if (currentDir === undefined) {
      break;
    }

    let entries;

    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name === "." || entry.name === "..") {
        continue;
      }

      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path
        .relative(rootDir, absolutePath)
        .replace(/\\/gu, "/");

      if (entry.isDirectory()) {
        if (IGNORED_DIR_NAMES.has(entry.name) || entry.name.startsWith(".git")) {
          continue;
        }

        stack.push(absolutePath);
        continue;
      }

      if (!entry.isFile() && !entry.isSymbolicLink()) {
        continue;
      }

      try {
        const fileStat = await stat(absolutePath);

        if (fileStat.mtimeMs >= sinceMs) {
          results.push(relativePath);
        }
      } catch {
        // Race: file deleted mid-walk.
      }
    }
  }

  return results;
}

/**
 * Returns paths modified under `rootDir` since `sinceMs` that violate the
 * docs-only policy, or an empty array when the boundary is not enforced.
 */
export async function findDisallowedWrites(
  rootDir: string,
  sinceMs: number,
  boundary: AgentCliWriteBoundary,
): Promise<string[]> {
  if (boundary === "none") {
    return [];
  }

  const modified = await listFilesModifiedSince(rootDir, sinceMs);

  return modified.filter((relativePath) => !isAllowedDocsOnlyWritePath(relativePath));
}

export function formatDisallowedWritesError(
  providerLabel: string,
  disallowed: string[],
): string {
  const sample = disallowed.slice(0, 8).join(", ");
  const more =
    disallowed.length > 8 ? ` (+${disallowed.length - 8} more)` : "";

  return (
    `${providerLabel} modified files outside the OpenWiki docs-only write boundary ` +
    `(only ${OPEN_WIKI_DIR}/, AGENTS.md, and CLAUDE.md are allowed for init/update). ` +
    `Disallowed paths: ${sample}${more}.`
  );
}
