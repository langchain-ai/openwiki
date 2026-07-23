import type { BackendProtocolV2, FileInfo } from "deepagents";
import path from "node:path";
import type { OpenWikiOutputMode } from "./types.js";

/**
 * Reserved or control files that never carry agent-authored concept links.
 */
const EXCLUDED_FILES = new Set([
  "index.md",
  "log.md",
  "_plan.md",
  "INSTRUCTIONS.md",
]);

const MARKDOWN_LINK_PATTERN = /\[([^\]]*)\]\(([^)]+)\)/gu;
const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*#*\s*$/u;
const BROKEN_LINK_STAMP_PATTERN =
  /^\s*<!--\s*openwiki:\s*broken internal link\b.*?-->\s*$/u;

export interface WikiLinkIssue {
  href: string;
  line: number;
  message: string;
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
        wikiRoot,
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

async function validateLink(
  backend: BackendProtocolV2,
  wikiRoot: string,
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

  const resolvedPath = resolveWikiLinkPath(wikiRoot, sourcePath, linkPath);
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

  if (!anchor || isDirectory) {
    return null;
  }

  const targetContent = await readText(backend, targetPath);
  const targetAnchors = buildHeadingAnchors(extractHeadings(targetContent));
  if (!targetAnchors.has(decodeURIComponent(anchor))) {
    return {
      href,
      line,
      message: `heading anchor "${anchor}" does not exist in ${targetPath}`,
      sourcePath,
    };
  }

  return null;
}

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

function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/gu, "")
    .replace(/\s+/gu, "-");
}

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

function resolveWikiLinkPath(
  wikiRoot: string,
  sourcePath: string,
  linkPath: string,
): string {
  if (linkPath.startsWith("/")) {
    return path.posix.join(wikiRoot, linkPath.slice(1));
  }

  return path.posix.normalize(
    path.posix.join(path.posix.dirname(sourcePath), linkPath),
  );
}

function isExternalHref(href: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(href);
}

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

function entryName(entry: FileInfo): string {
  return path.posix.basename(entry.path.replace(/\/$/u, ""));
}
