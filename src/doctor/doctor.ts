import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { OpenWikiLocalShellBackend } from "../agent/docs-only-backend.js";
import {
  surveyWikiSourceCitations,
  type WikiPageCitations,
} from "../agent/source-citation-validator.js";
import { OPEN_WIKI_DIR, UPDATE_METADATA_PATH } from "../config/constants.js";

const execFileAsync = promisify(execFile);

/**
 * Outcome of one health check over a repository's checked-in wiki.
 */
export interface WikiDoctorResult {
  /**
   * True when at least one citation points at a file that no longer exists.
   * Staleness alone is not an issue: it is the expected state between runs.
   */
  hasIssues: boolean;

  /**
   * The rendered, human-readable report.
   */
  report: string;
}

/**
 * Checks a repository wiki's factual grounding without running a model.
 *
 * Two questions are answered deterministically. First, does every repository
 * file the wiki cites still exist, and where did the missing ones move? Second,
 * which pages cite files that changed since the commit the wiki last
 * documented, and are therefore the pages an update run should revisit?
 *
 * Both come from the wiki text and git alone, so this is cheap enough to run in
 * CI on every pull request.
 */
export async function runWikiDoctor(cwd: string): Promise<WikiDoctorResult> {
  const wikiRoot = path.join(cwd, OPEN_WIKI_DIR);
  if (!(await isDirectory(wikiRoot))) {
    throw new Error(
      `No ${OPEN_WIKI_DIR}/ directory in ${cwd}. Run \`openwiki code --init\` to generate one.`,
    );
  }

  const backend = new OpenWikiLocalShellBackend({
    docsOnly: true,
    outputMode: "repository",
    rootDir: cwd,
    virtualMode: true,
  });

  const pages = await surveyWikiSourceCitations(backend, "repository");
  const staleness = await getStaleness(cwd);

  return {
    hasIssues: pages.some((page) => page.missing.length > 0),
    report: formatReport(pages, staleness),
  };
}

/**
 * Which repository files changed since the wiki was last generated.
 */
interface StalenessContext {
  /**
   * Short form of the commit the wiki last documented.
   */
  base: string;

  /**
   * Repository-relative paths that changed between that commit and HEAD.
   */
  changedPaths: Set<string>;
}

/**
 * Renders the full report.
 */
function formatReport(
  pages: WikiPageCitations[],
  staleness: StalenessContext | null,
): string {
  const citationCount = pages.reduce(
    (total, page) => total + page.citedPaths.length,
    0,
  );
  const lines = [
    "OpenWiki doctor",
    "",
    `Scanned ${formatCount(pages.length, "page")} and ${formatCount(
      citationCount,
      "source citation",
    )} in ${OPEN_WIKI_DIR}/.`,
    "",
    ...formatMissingSection(pages),
  ];

  if (staleness) {
    lines.push("", ...formatStaleSection(pages, staleness));
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Renders the missing-citation section, which is the actionable half.
 */
function formatMissingSection(pages: WikiPageCitations[]): string[] {
  const affected = pages.filter((page) => page.missing.length > 0);
  if (affected.length === 0) {
    return ["Source references: every cited file exists."];
  }

  const total = affected.reduce((sum, page) => sum + page.missing.length, 0);
  const lines = [`Stale source references (${total})`];

  for (const page of affected) {
    lines.push(`  ${toRepositoryPath(page.sourcePath)}`);
    for (const issue of page.missing) {
      lines.push(
        `    line ${issue.line}: ${issue.citedPath} -> ${issue.suggestions.join(" | ")}`,
      );
    }
  }

  return lines;
}

/**
 * Renders the staleness section, which is informational: it tells an update run
 * where to look rather than reporting a defect.
 */
function formatStaleSection(
  pages: WikiPageCitations[],
  staleness: StalenessContext,
): string[] {
  const affected = pages
    .map((page) => ({
      changed: new Set(
        page.citedPaths.filter((citedPath) =>
          staleness.changedPaths.has(citedPath),
        ),
      ),
      page,
    }))
    .filter((entry) => entry.changed.size > 0)
    .sort((left, right) => right.changed.size - left.changed.size);

  if (affected.length === 0) {
    return [
      `No cited file changed since ${staleness.base}; the wiki is current.`,
    ];
  }

  const lines = [
    `Pages citing files changed since ${staleness.base} (${affected.length})`,
  ];

  for (const { changed, page } of affected) {
    const unique = new Set(page.citedPaths).size;
    lines.push(
      `  ${toRepositoryPath(page.sourcePath)}: ${changed.size} of ${unique} cited files changed`,
    );
  }

  return lines;
}

/**
 * Loads the commit the wiki last documented and diffs it against HEAD.
 *
 * Every failure here is non-fatal and drops the staleness section: the run
 * metadata may be absent on a fresh wiki, and the recorded commit may be
 * unreachable in a shallow clone. Neither says anything about wiki health.
 */
async function getStaleness(cwd: string): Promise<StalenessContext | null> {
  const base = await readDocumentedCommit(cwd);
  if (!base) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["--no-pager", "diff", "--name-only", `${base}..HEAD`],
      { cwd, maxBuffer: 8 * 1024 * 1024 },
    );

    return {
      base: base.slice(0, 8),
      changedPaths: new Set(
        stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      ),
    };
  } catch {
    return null;
  }
}

/**
 * Reads the git commit recorded by the last completed run.
 */
async function readDocumentedCommit(cwd: string): Promise<string | null> {
  try {
    const raw = await readFile(path.join(cwd, UPDATE_METADATA_PATH), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "gitHead" in parsed &&
      typeof parsed.gitHead === "string" &&
      parsed.gitHead.length > 0
    ) {
      return parsed.gitHead;
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Converts a wiki-absolute backend path to a repository-relative one.
 */
function toRepositoryPath(sourcePath: string): string {
  return sourcePath.replace(/^\/+/u, "");
}

/**
 * Pluralizes a labelled count.
 */
function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * True when a path exists and is a directory.
 */
async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}
