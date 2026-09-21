import type { BackendProtocolV2, FileInfo } from "deepagents";
import path from "node:path";
import type { OpenWikiOutputMode } from "./types.js";

/**
 * Reserved or control files that never carry agent-authored source citations.
 */
const EXCLUDED_FILES = new Set([
  "index.md",
  "log.md",
  "_plan.md",
  "INSTRUCTIONS.md",
]);

/**
 * Directories that never contain citable first-party source and would make a
 * repository-wide walk pathologically slow.
 */
const UNWALKED_DIRECTORIES = new Set([
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
]);

/**
 * Matches an opening or closing fenced code block marker, capturing the fence
 * run so a nested marker of a different type does not toggle the fence.
 */
const FENCE_PATTERN = /^\s*(`{3,}|~{3,})/u;

/**
 * Matches an inline code span, capturing its contents. Spans containing a
 * backtick or newline are out of scope because a citation never needs one.
 */
const CODE_SPAN_PATTERN = /`([^`\n]+)`/gu;

/**
 * Matches a slash-separated relative path built only from characters that are
 * safe in a repository path. Requiring at least one slash keeps bare words
 * (`README`, `pnpm`) and bare file names out of the candidate set.
 */
const RELATIVE_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/u;

/**
 * Matches a trailing file extension that starts with a letter. Requiring a
 * letter rejects version-like tails (the `.2` of `z-ai/glm-5.2`) that would
 * otherwise read as an extension.
 */
const FILE_EXTENSION_PATTERN = /\.[A-Za-z][A-Za-z0-9]{0,9}$/u;

/**
 * Matches a previously inserted stale-source stamp line, so stamps can be
 * cleared before each pass and never accumulate across runs.
 */
const STALE_SOURCE_STAMP_PATTERN =
  /^\s*<!--\s*openwiki:\s*stale source reference\b.*?-->\s*$/u;

/**
 * How many relocation candidates a stamp names before the list is truncated.
 */
const MAX_SUGGESTIONS = 3;

/**
 * One wiki citation pointing at a repository file that no longer exists.
 */
export interface SourceCitationIssue {
  /**
   * The repository-relative path exactly as written in the wiki page.
   */
  citedPath: string;

  /**
   * 1-based line number of the citation within its source file.
   */
  line: number;

  /**
   * Human-readable reason the citation is broken, including any relocation
   * candidates found elsewhere in the repository.
   */
  message: string;

  /**
   * Wiki-absolute path of the page the citation was found in.
   */
  sourcePath: string;

  /**
   * Repository-relative paths of files sharing the cited file's name, which are
   * the likely destinations of the move. Never empty: a citation with no such
   * candidate is not reported.
   */
  suggestions: string[];
}

/**
 * Summary of one source-citation validation pass over a generated wiki.
 */
export interface SourceCitationReport {
  /**
   * How many repository paths cited in prose were resolved.
   */
  citationsChecked: number;

  /**
   * How many Markdown files were scanned.
   */
  filesScanned: number;

  /**
   * Every citation whose target file is missing.
   */
  issues: SourceCitationIssue[];

  /**
   * Wiki-root-relative paths of files that were rewritten with stamps. Always
   * empty for a read-only scan.
   */
  stampedFiles: string[];
}

/**
 * Validates the repository paths a wiki cites in prose, stamping citations
 * that a file move has invalidated instead of failing the run.
 *
 * A wiki's most frequent factual claim is "this behavior lives in this file",
 * and a repository reorganization silently invalidates every one of them. The
 * generated Markdown writes those claims as inline code spans rather than
 * links, so internal-link validation cannot see them.
 *
 * A citation is reported only when its file is missing *and* a file of the same
 * name exists elsewhere in the repository. That gate is deliberate. A missing
 * file with no such twin is ambiguous: the wiki may be describing a path the
 * reader creates in their own repository (`openwiki/.langsmith.json`), an
 * artifact written at runtime, or a genuinely deleted file, and only the last
 * is a defect. A move, by contrast, is self-evidencing and comes with the
 * correct path already in hand, so every report is actionable and checkable.
 * Precision matters more than recall here: a validator that reports a plausible
 * path as broken is one maintainers turn off.
 *
 * Each reported citation is preceded by an HTML comment naming where the file
 * went, so a later update run repairs the path from that comment. Existing
 * stamps are cleared first, so a corrected citation leaves no residual comment.
 */
export async function validateWikiSourceCitations(
  backend: BackendProtocolV2,
  outputMode: OpenWikiOutputMode,
): Promise<SourceCitationReport> {
  const scan = await scanWikiSourceCitations(backend, outputMode);
  const report: SourceCitationReport = {
    citationsChecked: scan.citationsChecked,
    filesScanned: scan.files.length,
    issues: scan.files.flatMap((file) => file.issues),
    stampedFiles: [],
  };

  for (const file of scan.files) {
    const stamped = stampSourceCitations(file.cleaned, file.issues);
    if (stamped === file.original) {
      continue;
    }

    const result = await backend.edit(file.sourcePath, file.original, stamped);
    if (result.error) {
      throw new Error(`Unable to rewrite ${file.sourcePath}: ${result.error}`);
    }

    report.stampedFiles.push(
      path.posix.relative(getWikiRoot(outputMode), file.sourcePath),
    );
  }

  return report;
}

/**
 * Every repository path one wiki page cites, and which of them are missing.
 */
export interface WikiPageCitations {
  /**
   * Repository-relative paths the page cites, in document order, including the
   * ones that still resolve.
   */
  citedPaths: string[];

  /**
   * Citations whose target file no longer exists.
   */
  missing: SourceCitationIssue[];

  /**
   * Wiki-absolute path of the page.
   */
  sourcePath: string;
}

/**
 * Surveys every wiki page's source citations without rewriting any file, for
 * reporting surfaces that must not mutate the tree.
 */
export async function surveyWikiSourceCitations(
  backend: BackendProtocolV2,
  outputMode: OpenWikiOutputMode,
): Promise<WikiPageCitations[]> {
  const scan = await scanWikiSourceCitations(backend, outputMode);

  return scan.files.map((file) => ({
    citedPaths: file.citedPaths,
    missing: file.issues,
    sourcePath: file.sourcePath,
  }));
}

/**
 * Formats citation issues into a single actionable diagnostic message.
 */
export function formatSourceCitationIssues(
  issues: SourceCitationIssue[],
): string {
  const lines = issues.map(
    (issue) =>
      `${issue.sourcePath}:${issue.line} [${issue.citedPath}] ${issue.message}`,
  );
  return `OpenWiki source citation validation found missing files:\n${lines.join("\n")}`;
}

/**
 * Builds the HTML comment stamp placed above a broken source citation.
 */
export function formatStaleSourceStamp(
  citedPath: string,
  message: string,
): string {
  return (
    `<!-- openwiki: stale source reference [${citedPath}] ${message}. ` +
    `Read the replacement file, correct the path and any claim that depended ` +
    `on it, then delete this comment. -->`
  );
}

/**
 * Removes prior stale-source stamps so revalidation starts from clean content.
 */
export function stripStaleSourceStamps(content: string): string {
  return content
    .split(/\r?\n/u)
    .filter((line) => !STALE_SOURCE_STAMP_PATTERN.test(line))
    .join("\n");
}

/**
 * Inserts stale-source stamps above each failing citation line (bottom-up).
 */
export function stampSourceCitations(
  content: string,
  issues: SourceCitationIssue[],
): string {
  if (issues.length === 0) {
    return content;
  }

  const lines = content.split(/\r?\n/u);
  const byLine = new Map<number, SourceCitationIssue[]>();
  for (const issue of issues) {
    const group = byLine.get(issue.line) ?? [];
    group.push(issue);
    byLine.set(issue.line, group);
  }

  for (const lineNumber of [...byLine.keys()].sort((a, b) => b - a)) {
    const stamps = (byLine.get(lineNumber) ?? []).map((issue) =>
      formatStaleSourceStamp(issue.citedPath, issue.message),
    );
    lines.splice(lineNumber - 1, 0, ...stamps);
  }

  return lines.join("\n");
}

/**
 * Extracts every repository path a document cites in an inline code span, with
 * its 1-based line number.
 *
 * Only spans that are unambiguously a path claim are returned: they must be
 * slash-separated, carry a file extension, avoid traversal segments, and begin
 * with a directory that actually exists at the repository root. That last check
 * is what separates a real citation from the many slash-bearing strings a wiki
 * legitimately mentions, such as the model id `z-ai/glm-5.2`, the repository
 * slug `langchain-ai/openwiki`, or the media type `application/json`.
 *
 * Content inside fenced code blocks is skipped. A fence holds illustrative
 * examples and command output, where a path is a sample rather than a claim
 * about this repository.
 */
export function extractSourceCitations(
  content: string,
  topLevelDirectories: ReadonlySet<string>,
): Array<{ citedPath: string; line: number }> {
  const citations: Array<{ citedPath: string; line: number }> = [];
  const lines = content.split(/\r?\n/u);
  let openFence: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = FENCE_PATTERN.exec(line)?.[1];

    if (fence) {
      if (openFence === null) {
        openFence = fence;
        continue;
      }
      if (fence[0] === openFence[0] && fence.length >= openFence.length) {
        openFence = null;
      }
      continue;
    }

    if (openFence !== null) {
      continue;
    }

    for (const match of line.matchAll(CODE_SPAN_PATTERN)) {
      const candidate = match[1].trim();
      if (isSourceCitation(candidate, topLevelDirectories)) {
        citations.push({ citedPath: candidate, line: index + 1 });
      }
    }
  }

  return citations;
}

/**
 * True when a code span reads as a claim about a file in this repository.
 */
function isSourceCitation(
  candidate: string,
  topLevelDirectories: ReadonlySet<string>,
): boolean {
  if (
    !RELATIVE_PATH_PATTERN.test(candidate) ||
    !FILE_EXTENSION_PATTERN.test(candidate)
  ) {
    return false;
  }

  const segments = candidate.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return false;
  }

  return topLevelDirectories.has(segments[0]);
}

/**
 * Per-file scan result, retained so stamping can reuse the content that
 * produced the issues instead of reading each page twice.
 */
interface ScannedPage {
  citedPaths: string[];
  cleaned: string;
  issues: SourceCitationIssue[];
  original: string;
  sourcePath: string;
}

/**
 * Reads every wiki page and resolves its citations against the repository
 * index. `local-wiki` runs are skipped: a personal wiki documents connector
 * data rather than a source tree, so a path-shaped span there cites nothing.
 */
async function scanWikiSourceCitations(
  backend: BackendProtocolV2,
  outputMode: OpenWikiOutputMode,
): Promise<{ citationsChecked: number; files: ScannedPage[] }> {
  if (outputMode === "local-wiki") {
    return { citationsChecked: 0, files: [] };
  }

  const index = await buildRepositoryIndex(backend);
  const files: ScannedPage[] = [];
  let citationsChecked = 0;

  for (const sourcePath of await collectMarkdownFiles(
    backend,
    getWikiRoot(outputMode),
  )) {
    const original = await readText(backend, sourcePath);
    const cleaned = stripStaleSourceStamps(original);
    const issues: SourceCitationIssue[] = [];
    const citedPaths: string[] = [];

    for (const { citedPath, line } of extractSourceCitations(
      cleaned,
      index.topLevelDirectories,
    )) {
      citationsChecked += 1;
      citedPaths.push(citedPath);
      if (index.files.has(citedPath)) {
        continue;
      }

      const suggestions = (
        index.byBaseName.get(path.posix.basename(citedPath)) ?? []
      ).slice(0, MAX_SUGGESTIONS);

      // Precision gate: report only citations that a move explains. See
      // {@link validateWikiSourceCitations} for why the remainder are ignored.
      if (suggestions.length === 0) {
        continue;
      }

      issues.push({
        citedPath,
        line,
        message: formatMissingSourceMessage(citedPath, suggestions),
        sourcePath,
        suggestions,
      });
    }

    files.push({ citedPaths, cleaned, issues, original, sourcePath });
  }

  return { citationsChecked, files };
}

/**
 * Describes a moved citation, naming where the file now lives.
 */
function formatMissingSourceMessage(
  citedPath: string,
  suggestions: string[],
): string {
  const base = `source file "${citedPath}" does not exist`;
  if (suggestions.length === 1) {
    return `${base}; a file with that name is now at "${suggestions[0]}"`;
  }

  const quoted = suggestions.map((suggestion) => `"${suggestion}"`).join(", ");
  return `${base}; files with that name are now at ${quoted}`;
}

/**
 * The repository paths a citation can resolve against.
 */
interface RepositoryIndex {
  /**
   * Repository-relative file paths grouped by file name, for rename detection.
   */
  byBaseName: Map<string, string[]>;

  /**
   * Every indexed repository-relative file path.
   */
  files: Set<string>;

  /**
   * Names of the directories at the repository root, which gate whether a
   * path-shaped code span is treated as a citation at all.
   */
  topLevelDirectories: Set<string>;
}

/**
 * Walks the repository once, indexing file paths for existence checks and file
 * names for rename suggestions.
 */
async function buildRepositoryIndex(
  backend: BackendProtocolV2,
): Promise<RepositoryIndex> {
  const index: RepositoryIndex = {
    byBaseName: new Map(),
    files: new Set(),
    topLevelDirectories: new Set(),
  };

  await indexDirectory(backend, "/", "", index, true);

  return index;
}

/**
 * Recursively indexes one directory, skipping dot-directories and build output.
 */
async function indexDirectory(
  backend: BackendProtocolV2,
  directoryPath: string,
  relativePath: string,
  index: RepositoryIndex,
  isRoot: boolean,
): Promise<void> {
  const result = await backend.ls(directoryPath);
  if (result.error) {
    return;
  }

  for (const entry of result.files ?? []) {
    const name = entryName(entry);
    if (!name) {
      continue;
    }

    const childRelativePath = relativePath ? `${relativePath}/${name}` : name;

    if (entry.is_dir) {
      // Dot-directories are never walked, which keeps `.git` out of the index.
      // Their contents are consistently invisible: because a citation is only
      // recognized when its first segment is an indexed top-level directory, a
      // path such as `.github/workflows/openwiki.yml` is skipped rather than
      // reported missing.
      if (name.startsWith(".") || UNWALKED_DIRECTORIES.has(name)) {
        continue;
      }
      if (isRoot) {
        index.topLevelDirectories.add(name);
      }
      await indexDirectory(
        backend,
        path.posix.join(directoryPath, name),
        childRelativePath,
        index,
        false,
      );
      continue;
    }

    // Dot-files are indexed: a wiki legitimately cites run metadata such as
    // `openwiki/.last-update.json`.
    index.files.add(childRelativePath);
    const siblings = index.byBaseName.get(name) ?? [];
    siblings.push(childRelativePath);
    index.byBaseName.set(name, siblings);
  }
}

/**
 * Recursively collects wiki-absolute paths of every non-excluded Markdown
 * file under a directory, skipping dotfiles and reserved control files.
 */
async function collectMarkdownFiles(
  backend: BackendProtocolV2,
  directoryPath: string,
): Promise<string[]> {
  const result = await backend.ls(directoryPath);
  if (result.error) {
    return [];
  }

  const files: string[] = [];
  for (const entry of result.files ?? []) {
    const name = entryName(entry);
    if (!name || name.startsWith(".")) {
      continue;
    }

    const entryPath = path.posix.join(directoryPath, name);
    if (entry.is_dir) {
      files.push(...(await collectMarkdownFiles(backend, entryPath)));
      continue;
    }

    if (
      path.posix.extname(name).toLowerCase() === ".md" &&
      !EXCLUDED_FILES.has(name)
    ) {
      files.push(entryPath);
    }
  }

  return files.sort();
}

/**
 * Resolves the wiki content root for an output mode.
 */
function getWikiRoot(outputMode: OpenWikiOutputMode): string {
  return outputMode === "local-wiki" ? "/" : "/openwiki";
}

/**
 * Reads a backend file as text, joining array content into a string and
 * throwing when the file is missing or not text.
 */
async function readText(
  backend: BackendProtocolV2,
  filePath: string,
): Promise<string> {
  const result = await backend.readRaw(filePath);
  if (result.error) {
    throw new Error(`Unable to read ${filePath}: ${result.error}`);
  }

  const content = result.data?.content;
  if (Array.isArray(content)) {
    return content.join("\n");
  }
  if (typeof content === "string") {
    return content;
  }

  throw new Error(`${filePath} is not a text file.`);
}

/**
 * Returns the base file name of a directory entry, tolerating a trailing slash.
 */
function entryName(entry: FileInfo): string {
  return path.posix.basename(entry.path.replace(/\/$/u, ""));
}
