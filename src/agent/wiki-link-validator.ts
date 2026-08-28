import type { BackendProtocolV2, FileInfo } from "deepagents";
import path from "node:path";
import type { OpenWikiOutputMode } from "./types.js";

/**
 * Reserved or control files that never carry agent-authored concept links.
 */
const EXCLUDED_FILES = new Set(["index.md", "log.md", "INSTRUCTIONS.md"]);

/**
 * Matches a Markdown inline link, capturing its text and destination. Image
 * links (`![alt](src)`) are rejected by the caller via the preceding `!`.
 */
const MARKDOWN_LINK_PATTERN = /\[([^\]]*)\]\(([^)]+)\)/gu;

/**
 * Matches an ATX heading, capturing its hashes and trimmed title text. The
 * title feeds anchor-slug generation.
 */
const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*#*\s*$/u;

/**
 * Matches a previously inserted broken-link stamp line, so stamps can be
 * cleared before each pass and never accumulate across runs.
 */
const BROKEN_LINK_STAMP_PATTERN =
  /^\s*<!--\s*openwiki:\s*broken internal link\b.*?-->\s*$/u;

/**
 * One broken internal link found during a validation pass.
 */
export interface WikiLinkIssue {
  /**
   * The link destination exactly as written in the source Markdown.
   */
  href: string;

  /**
   * 1-based line number of the link within its source file.
   */
  line: number;

  /**
   * Human-readable reason the link is broken (missing file, anchor, etc.).
   */
  message: string;

  /**
   * Wiki-absolute path of the file the broken link was found in.
   */
  sourcePath: string;
}

/**
 * Summary of one internal-link validation pass over a generated wiki.
 */
export interface WikiLinkReport {
  /**
   * How many Markdown files were scanned.
   */
  filesScanned: number;

  /**
   * How many relative internal links were checked.
   */
  linksChecked: number;

  /**
   * How many broken links were found (and stamped).
   */
  issuesFound: number;

  /**
   * Wiki-root-relative paths of files that were rewritten with stamps.
   */
  stampedFiles: string[];
}

/**
 * Validates relative wiki links and GitHub-style heading anchors after
 * generation, stamping broken links in place instead of failing the run.
 *
 * Each broken link is preceded by an HTML comment so a later update run can
 * find it inline and repair the href. Existing stamps are cleared first, so a
 * fixed link leaves no residual comment.
 */
export async function validateWikiInternalLinks(
  backend: BackendProtocolV2,
  outputMode: OpenWikiOutputMode,
): Promise<WikiLinkReport> {
  const wikiRoot = outputMode === "local-wiki" ? "/" : "/openwiki";
  const report: WikiLinkReport = {
    filesScanned: 0,
    linksChecked: 0,
    issuesFound: 0,
    stampedFiles: [],
  };

  for (const sourcePath of await collectMarkdownFiles(backend, wikiRoot)) {
    report.filesScanned += 1;
    const original = await readText(backend, sourcePath);
    const cleaned = stripBrokenLinkStamps(original);
    const headingAnchors = buildHeadingAnchors(extractHeadings(cleaned));
    const issues: WikiLinkIssue[] = [];

    for (const { href, line } of extractMarkdownLinks(cleaned)) {
      report.linksChecked += 1;
      const issue = await validateLink(
        backend,
        sourcePath,
        href,
        line,
        headingAnchors,
      );
      if (issue) {
        issues.push(issue);
      }
    }

    report.issuesFound += issues.length;
    const stamped = stampBrokenLinks(cleaned, issues);
    if (stamped === original) {
      continue;
    }

    const result = await backend.edit(sourcePath, original, stamped);
    if (result.error) {
      throw new Error(`Unable to rewrite ${sourcePath}: ${result.error}`);
    }

    report.stampedFiles.push(path.posix.relative(wikiRoot, sourcePath));
  }

  return report;
}

/**
 * Formats link issues into a single actionable diagnostic message.
 */
export function formatWikiLinkIssues(issues: WikiLinkIssue[]): string {
  const lines = issues.map(
    (issue) =>
      `${issue.sourcePath}:${issue.line} [${issue.href}] ${issue.message}`,
  );
  return `OpenWiki internal link validation found broken links:\n${lines.join("\n")}`;
}

/**
 * Builds the HTML comment stamp placed above a broken internal link.
 */
export function formatBrokenLinkStamp(href: string, message: string): string {
  return (
    `<!-- openwiki: broken internal link [${href}] ${message}. ` +
    `Fix the href or restore the target, then delete this comment. -->`
  );
}

/**
 * Removes prior broken-link stamps so revalidation starts from clean content.
 */
export function stripBrokenLinkStamps(content: string): string {
  return content
    .split(/\r?\n/u)
    .filter((line) => !BROKEN_LINK_STAMP_PATTERN.test(line))
    .join("\n");
}

/**
 * Inserts broken-link stamps above each failing link line (bottom-up).
 */
export function stampBrokenLinks(
  content: string,
  issues: WikiLinkIssue[],
): string {
  if (issues.length === 0) {
    return content;
  }

  const lines = content.split(/\r?\n/u);
  const byLine = new Map<number, WikiLinkIssue[]>();
  for (const issue of issues) {
    const group = byLine.get(issue.line) ?? [];
    group.push(issue);
    byLine.set(issue.line, group);
  }

  for (const lineNumber of [...byLine.keys()].sort((a, b) => b - a)) {
    const stamps = (byLine.get(lineNumber) ?? []).map((issue) =>
      formatBrokenLinkStamp(issue.href, issue.message),
    );
    lines.splice(lineNumber - 1, 0, ...stamps);
  }

  return lines.join("\n");
}

/**
 * Validates one link, returning an issue when the target file, directory, or
 * heading anchor cannot be resolved. External links and bare (empty) hrefs are
 * ignored.
 *
 * Targets are checked by existence against the whole repository, not just the
 * wiki subtree: a wiki page may legitimately link out to a repo file (a design
 * doc, source file, etc.), which renders correctly on GitHub. A link is broken
 * only when its target genuinely does not exist.
 */
async function validateLink(
  backend: BackendProtocolV2,
  sourcePath: string,
  rawHref: string,
  line: number,
  sourceAnchors: Set<string>,
): Promise<WikiLinkIssue | null> {
  const href = rawHref.trim();
  if (!href || isExternalHref(href)) {
    return null;
  }

  const { anchor, path: linkPath } = parseLinkDestination(href);
  if (!linkPath) {
    if (!anchor) {
      return null;
    }
    if (!sourceAnchors.has(decodeURIComponent(anchor))) {
      return {
        href,
        line,
        message: `heading anchor "${anchor}" does not exist in ${sourcePath}`,
        sourcePath,
      };
    }
    return null;
  }

  const resolvedPath = resolveRepoLinkPath(sourcePath, linkPath);
  if (!resolvedPath) {
    return {
      href,
      line,
      message: `link "${linkPath}" cannot be resolved`,
      sourcePath,
    };
  }

  const isDirectory = resolvedPath.endsWith("/");
  const targetPath = isDirectory
    ? resolvedPath.replace(/\/+$/u, "")
    : resolvedPath;

  if (!(await pathExists(backend, targetPath, isDirectory))) {
    return {
      href,
      line,
      message: isDirectory
        ? `directory "${linkPath}" does not exist`
        : `file "${linkPath}" does not exist`,
      sourcePath,
    };
  }

  // Heading anchors are only validated against Markdown targets. Anchors on
  // directories, and GitHub line anchors on source files (e.g. `#L10`), are
  // out of scope and must not be flagged as broken.
  if (
    !anchor ||
    isDirectory ||
    path.posix.extname(targetPath).toLowerCase() !== ".md"
  ) {
    return null;
  }

  const targetContent = await readText(backend, targetPath);
  const targetAnchors = buildHeadingAnchors(extractHeadings(targetContent));
  if (!targetAnchors.has(decodeURIComponent(anchor))) {
    return {
      href,
      line,
      message: `heading anchor "${anchor}" does not exist in "${linkPath}"`,
      sourcePath,
    };
  }

  return null;
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
 * Extracts every inline Markdown link with its 1-based line number, skipping
 * image links.
 */
function extractMarkdownLinks(
  content: string,
): Array<{ href: string; line: number }> {
  const links: Array<{ href: string; line: number }> = [];
  const lines = content.split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const match of line.matchAll(MARKDOWN_LINK_PATTERN)) {
      if (match.index !== undefined && line[match.index - 1] === "!") {
        continue;
      }
      links.push({ href: match[2], line: index + 1 });
    }
  }

  return links;
}

/**
 * Extracts the trimmed title text of every ATX heading in a document.
 */
function extractHeadings(content: string): string[] {
  const headings: string[] = [];
  for (const line of content.split(/\r?\n/u)) {
    const match = HEADING_PATTERN.exec(line);
    if (match) {
      headings.push(match[2]);
    }
  }
  return headings;
}

/**
 * Builds the set of GitHub-style anchor slugs a document exposes, appending
 * `-1`, `-2`, ... to duplicate slugs exactly as GitHub does.
 */
function buildHeadingAnchors(headings: string[]): Set<string> {
  const counts = new Map<string, number>();
  const anchors = new Set<string>();

  for (const heading of headings) {
    const base = slugifyHeading(heading);
    if (!base) {
      continue;
    }

    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }

  return anchors;
}

/**
 * Converts heading text to a GitHub-style anchor slug: lowercased, punctuation
 * removed, each whitespace character replaced by a single hyphen. Unicode
 * letters, numbers, and combining marks are kept (matching GitHub), so anchors
 * on non-English headings resolve correctly.
 *
 * The kept-character class mirrors `github-slugger` exactly: `\p{M}` retains
 * combining marks so a decomposed (NFD) accent like `e` + U+0301 slugs to `é`
 * rather than a bare `e`, matching how GitHub renders the anchor.
 *
 * Whitespace is replaced per-character, not collapsed, because GitHub does the
 * same: stripping punctuation between two words (e.g. `&` in "A & B") leaves
 * two spaces that become two hyphens (`a--b`). Collapsing them would compute
 * `a-b` and falsely flag the valid `#a--b` anchor as broken.
 */
function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
    .replace(/\s/gu, "-");
}

/**
 * Splits a link destination into its path and optional `#anchor`, dropping any
 * trailing Markdown link title (e.g. `path "Title"`).
 */
function parseLinkDestination(rawHref: string): {
  anchor?: string;
  path: string;
} {
  const withoutTitle = rawHref.replace(/\s+(["']).*\1\s*$/u, "").trim();
  const hashIndex = withoutTitle.indexOf("#");
  if (hashIndex === -1) {
    return { path: withoutTitle };
  }

  return {
    anchor: withoutTitle.slice(hashIndex + 1),
    path: withoutTitle.slice(0, hashIndex),
  };
}

/**
 * Resolves a link path to a normalized repo-absolute path, or undefined when it
 * cannot be contained within the repo root.
 *
 * A leading-slash link is absolute from the virtual filesystem root (the repo
 * root in `repository` mode, the wiki dir in `local-wiki` mode) — the same
 * convention the generation prompt teaches and GitHub renders. A relative link
 * resolves against its source file's directory.
 *
 * The result is not constrained to the wiki subtree: wiki pages may link out to
 * other repo files, so containment is enforced at the repo root instead.
 * `path.posix.normalize` clamps any leading `..` at `/`, so a normalized
 * absolute path can never climb above the repo root that the backend's virtual
 * filesystem maps (e.g. `/openwiki/a/../../../etc` normalizes to `/etc`, still
 * under `/`). The explicit absolute-path check below makes that containment a
 * hard guarantee rather than an implicit one.
 */
function resolveRepoLinkPath(
  sourcePath: string,
  linkPath: string,
): string | null {
  const candidate = path.posix.normalize(
    linkPath.startsWith("/")
      ? linkPath
      : path.posix.join(path.posix.dirname(sourcePath), linkPath),
  );

  return path.posix.isAbsolute(candidate) ? candidate : null;
}

/**
 * True when a href points outside the wiki (has a URI scheme or is protocol-
 * relative), so external links are skipped by validation.
 */
function isExternalHref(href: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(href);
}

/**
 * True when a wiki-absolute path resolves to an existing file or directory on
 * the backend. Any read error is treated as "does not exist".
 */
async function pathExists(
  backend: BackendProtocolV2,
  targetPath: string,
  isDirectory: boolean,
): Promise<boolean> {
  try {
    if (isDirectory) {
      const result = await backend.ls(targetPath);
      return !result.error;
    }

    const result = await backend.readRaw(targetPath);
    return !result.error;
  } catch {
    return false;
  }
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
