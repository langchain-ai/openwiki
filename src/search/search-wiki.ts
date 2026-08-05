import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { WikiSearchHit, WikiSearchOptions } from "./types.js";

const DEFAULT_MAX_RESULTS = 20;
const DEFAULT_MAX_FILE_BYTES = 500_000;
const MAX_SNIPPET_LENGTH = 160;

export async function searchWiki(
  options: WikiSearchOptions,
): Promise<WikiSearchHit[]> {
  const query = options.query.trim();
  if (!query) {
    return [];
  }

  const terms = tokenizeQuery(query);
  if (terms.length === 0) {
    return [];
  }

  const maxResults = clamp(options.maxResults ?? DEFAULT_MAX_RESULTS, 1, 100);
  const maxFileBytes = clamp(
    options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    1,
    2_000_000,
  );
  const virtualRoot = normalizeVirtualRoot(options.virtualRoot ?? "/");

  const files = await listMarkdownFiles(options.rootDir, options.rootDir);
  const hits: WikiSearchHit[] = [];

  for (const absolutePath of files) {
    const relativePath = toPosixRelative(options.rootDir, absolutePath);
    let content: string;
    try {
      const raw = await readFile(absolutePath);
      if (raw.byteLength > maxFileBytes) {
        continue;
      }
      content = raw.toString("utf8");
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/u);
    const pathBoost = scorePathMatch(relativePath, terms);
    let fileTermHits = 0;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const lower = line.toLowerCase();
      const matchedTerms = terms.filter((term) => lower.includes(term));
      if (matchedTerms.length === 0) {
        continue;
      }

      // Prefer lines that cover more query terms (AND-ish ranking).
      const coverage = matchedTerms.length / terms.length;
      if (coverage < 1 && terms.length > 1 && matchedTerms.length === 1) {
        // Still keep single-term hits, but rank them lower than multi-term.
      }

      fileTermHits += matchedTerms.length;
      const score =
        matchedTerms.length * 10 +
        coverage * 5 +
        pathBoost +
        titleLineBoost(line);

      hits.push({
        path: relativePath,
        virtualPath: toVirtualPath(relativePath, virtualRoot),
        line: index + 1,
        snippet: truncateSnippet(line.trim()),
        score,
      });
    }

    // If the path matched but no line did, still emit a path-level hit so
    // filename matches (e.g. deepagents-backends.md for "backends") surface.
    if (pathBoost > 0 && fileTermHits === 0) {
      hits.push({
        path: relativePath,
        virtualPath: toVirtualPath(relativePath, virtualRoot),
        line: 1,
        snippet: `(filename match) ${relativePath}`,
        score: pathBoost,
      });
    }
  }

  hits.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (left.path !== right.path) {
      return left.path.localeCompare(right.path);
    }
    return left.line - right.line;
  });

  return dedupeHits(hits).slice(0, maxResults);
}

export function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

async function listMarkdownFiles(
  rootDir: string,
  currentDir: string,
): Promise<string[]> {
  let entries;
  try {
    await assertNotSymlink(currentDir);
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }

    const entryPath = path.join(currentDir, entry.name);
    try {
      await assertNotSymlink(entryPath);
    } catch {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(rootDir, entryPath)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(entryPath);
    }
  }

  return files;
}

async function assertNotSymlink(filePath: string): Promise<void> {
  const entryStat = await lstat(filePath);
  if (entryStat.isSymbolicLink()) {
    throw new Error("Symbolic links are not followed during wiki search.");
  }
}

function scorePathMatch(relativePath: string, terms: string[]): number {
  const haystack = relativePath.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) {
      score += 8;
    }
  }
  return score;
}

function titleLineBoost(line: string): number {
  const trimmed = line.trim();
  if (trimmed.startsWith("#")) {
    return 3;
  }
  if (trimmed.startsWith("title:")) {
    return 2;
  }
  return 0;
}

function dedupeHits(hits: WikiSearchHit[]): WikiSearchHit[] {
  const seen = new Set<string>();
  const result: WikiSearchHit[] = [];
  for (const hit of hits) {
    const key = `${hit.path}:${hit.line}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(hit);
  }
  return result;
}

function toPosixRelative(rootDir: string, absolutePath: string): string {
  return path
    .relative(rootDir, absolutePath)
    .split(path.sep)
    .join(path.posix.sep);
}

function normalizeVirtualRoot(virtualRoot: string): string {
  if (virtualRoot === "/") {
    return "/";
  }
  return virtualRoot.endsWith("/") ? virtualRoot : `${virtualRoot}/`;
}

function toVirtualPath(relativePath: string, virtualRoot: string): string {
  if (virtualRoot === "/") {
    return `/${relativePath}`;
  }
  return `${virtualRoot}${relativePath}`;
}

function truncateSnippet(snippet: string): string {
  if (snippet.length <= MAX_SNIPPET_LENGTH) {
    return snippet;
  }
  return `${snippet.slice(0, MAX_SNIPPET_LENGTH - 1)}…`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
