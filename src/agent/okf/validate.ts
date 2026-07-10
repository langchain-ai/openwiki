import path from "node:path";
import { OKF_INDEX_FILENAME, OKF_LOG_FILENAME } from "./taxonomy.js";
import {
  FRONTMATTER_PATTERN,
  isNonEmptyString,
  parseFrontmatter,
} from "./frontmatter.js";
import { collectMarkdownFiles, readFileOrNull } from "./bundle.js";

/**
 * A single conformance finding: an error (format violation) or a warning.
 */
export interface OkfFinding {
  /**
   * Severity: an error is a format violation; a warning is legal but low-quality.
   */
  level: "error" | "warning";

  /**
   * Stable machine-readable code for the finding kind.
   */
  code: string;

  /**
   * Bundle-relative path of the file the finding applies to.
   */
  file: string;

  /**
   * Human-readable description of the finding.
   */
  message: string;
}

/**
 * Checks a bundle against OKF v0.1 conformance. Errors are format violations;
 * warnings are legal but low-quality. Used by tests (no shipped CLI in v1).
 */
export async function validateBundle(root: string): Promise<OkfFinding[]> {
  const findings: OkfFinding[] = [];
  const markdownFiles = await collectMarkdownFiles(root);
  const validTargets = new Set(markdownFiles.map((file) => `/${file}`));

  for (const relativePath of markdownFiles) {
    const raw = await readFileOrNull(path.join(root, relativePath));
    if (raw === null) {
      continue;
    }
    const basename = path.basename(relativePath);

    if (basename === OKF_INDEX_FILENAME) {
      validateIndexFile(relativePath, raw, findings);
    } else if (basename === OKF_LOG_FILENAME) {
      validateLogFile(relativePath, raw, findings);
    } else {
      validateConceptFile(relativePath, raw, validTargets, findings);
    }
  }

  return findings;
}

/**
 * Validates a reserved index.md: only the root may carry frontmatter (okf_version).
 */
function validateIndexFile(rel: string, raw: string, out: OkfFinding[]): void {
  if (rel === OKF_INDEX_FILENAME) {
    const { data } = parseFrontmatter(raw);
    if (!isNonEmptyString(data.okf_version)) {
      out.push({
        level: "error",
        code: "root-index-version",
        file: rel,
        message: "root index.md must declare okf_version",
      });
    }
    const extra = Object.keys(data).filter((key) => key !== "okf_version");
    if (extra.length > 0) {
      out.push({
        level: "error",
        code: "index-frontmatter",
        file: rel,
        message: `root index.md has unexpected keys: ${extra.join(", ")}`,
      });
    }
    return;
  }

  if (FRONTMATTER_PATTERN.test(raw)) {
    out.push({
      level: "error",
      code: "index-frontmatter",
      file: rel,
      message: "non-root index.md must not have frontmatter",
    });
  }
}

/**
 * Validates that log.md date headings use ISO YYYY-MM-DD form.
 */
function validateLogFile(rel: string, raw: string, out: OkfFinding[]): void {
  for (const heading of raw.match(/^##\s+(.+)$/gmu) ?? []) {
    const date = heading.replace(/^##\s+/u, "").trim();
    if (!/^\d{4}-\d{2}-\d{2}/u.test(date)) {
      out.push({
        level: "error",
        code: "log-date",
        file: rel,
        message: `log.md heading is not ISO-dated: ${date}`,
      });
    }
  }
}

/**
 * Validates a concept: parseable frontmatter, non-empty type, links, description.
 */
function validateConceptFile(
  rel: string,
  raw: string,
  validTargets: Set<string>,
  out: OkfFinding[],
): void {
  const { data, body } = parseFrontmatter(raw);

  if (!FRONTMATTER_PATTERN.test(raw)) {
    out.push({
      level: "error",
      code: "missing-frontmatter",
      file: rel,
      message: "concept has no frontmatter block",
    });
  }
  if (!isNonEmptyString(data.type)) {
    out.push({
      level: "error",
      code: "missing-type",
      file: rel,
      message: "concept missing non-empty type",
    });
  }
  if (!isNonEmptyString(data.description)) {
    out.push({
      level: "warning",
      code: "missing-description",
      file: rel,
      message: "concept missing description",
    });
  }
  for (const target of extractMarkdownLinkTargets(body, rel)) {
    if (!validTargets.has(target)) {
      out.push({
        level: "warning",
        code: "broken-link",
        file: rel,
        message: `link target not found: ${target}`,
      });
    }
  }
}

/**
 * Extracts intra-bundle `.md` link targets, resolved to bundle-absolute paths.
 */
function extractMarkdownLinkTargets(body: string, from: string): string[] {
  const targets: string[] = [];
  const pattern = /\[[^\]]*\]\(([^)]+)\)/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const href = (match[1] ?? "").split(/[#\s]/u)[0] ?? "";
    if (href.length === 0 || /^[a-z]+:/iu.test(href) || !href.endsWith(".md")) {
      continue;
    }
    if (href.startsWith("/")) {
      targets.push(href);
    } else {
      const fromDir = path.posix.dirname(`/${from}`);
      targets.push(path.posix.normalize(path.posix.join(fromDir, href)));
    }
  }
  return targets;
}
