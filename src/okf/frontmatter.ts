import type { BackendProtocolV2 } from "deepagents";
import { parse } from "yaml";

/**
 * OKF fields that, when present, must be non-empty string values.
 */
const OKF_STRING_FIELDS = [
  "type",
  "title",
  "description",
  "resource",
  "timestamp",
];

/**
 * Extension field flagging front matter OpenWiki derived deterministically.
 */
export const OPENWIKI_GENERATED_FIELD = "openwiki_generated";

/**
 * Matches a leading YAML front-matter block and captures its inner text.
 */
const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;

/**
 * Minimal OKF fields OpenWiki can derive from a page body.
 */
interface DerivedFrontmatter {
  /**
   * Optional one-line summary derived from the first prose paragraph.
   */
  description?: string;

  /**
   * Concept title from the first H1, falling back to the filename.
   */
  title: string;

  /**
   * OKF concept type; defaults to "Reference" for derived pages.
   */
  type: string;
}

/**
 * A single structured problem found while validating front matter.
 */
export interface FrontmatterIssue {
  /**
   * Stable machine-readable issue code.
   */
  code: string;

  /**
   * 1-based line number the issue points at, when known.
   */
  line?: number;

  /**
   * Human-readable explanation of the problem.
   */
  message: string;
}

/**
 * Result of validating a Markdown file's OKF front matter.
 */
export type FrontmatterValidation =
  { valid: true } | { valid: false; issues: FrontmatterIssue[] };

/**
 * Parses and validates OKF front matter while tolerating producer extensions.
 */
export function validateOkfFrontmatter(content: string): FrontmatterValidation {
  const lines = content.split(/\r?\n/u);
  if (lines[0] !== "---") {
    return invalid(
      "missing_opening_delimiter",
      "File must begin with `---`.",
      1,
    );
  }

  const closingLine = lines.indexOf("---", 1);
  if (closingLine === -1) {
    return invalid(
      "missing_closing_delimiter",
      "Opening front matter has no closing `---` delimiter.",
    );
  }

  let fields: unknown;
  try {
    fields = parse(`\n${lines.slice(1, closingLine).join("\n")}`, {
      maxAliasCount: 100,
      schema: "core",
      uniqueKeys: true,
    }) as unknown;
  } catch (error) {
    return invalid("invalid_yaml", errorMessage(error));
  }
  if (!isRecord(fields)) {
    return invalid("invalid_yaml_root", "Front matter must be a YAML mapping.");
  }

  const issues: FrontmatterIssue[] = [];

  if (!Object.hasOwn(fields, "type")) {
    issues.push(issue("missing_type", "Required field `type` is missing."));
  }
  for (const field of OKF_STRING_FIELDS) {
    if (
      Object.hasOwn(fields, field) &&
      (typeof fields[field] !== "string" || !fields[field].trim())
    ) {
      issues.push(
        issue(
          `invalid_${field}`,
          `Field \`${field}\` must be a non-empty string.`,
        ),
      );
    }
  }
  if (
    Object.hasOwn(fields, "tags") &&
    (!Array.isArray(fields.tags) ||
      fields.tags.some((tag) => typeof tag !== "string" || !tag.trim()))
  ) {
    issues.push(
      issue(
        "invalid_tags",
        "Field `tags` must be a YAML list of non-empty strings.",
      ),
    );
  }

  return issues.length === 0 ? { valid: true } : { issues, valid: false };
}

/**
 * Reads a persisted Markdown file and validates its final front matter.
 */
export async function validatePersistedFile(
  backend: BackendProtocolV2,
  filePath: string,
): Promise<FrontmatterValidation> {
  const read = await backend.readRaw(filePath);
  const content = read.data?.content;
  if (read.error || content === undefined || content instanceof Uint8Array) {
    return invalid(
      "file_read_failed",
      `Could not read the final Markdown text: ${read.error ?? "no text data"}.`,
    );
  }
  return validateOkfFrontmatter(
    Array.isArray(content) ? content.join("\n") : content,
  );
}

/**
 * Creates a failed validation result containing one issue.
 */
function invalid(
  code: string,
  message: string,
  line?: number,
): FrontmatterValidation {
  return { issues: [issue(code, message, line)], valid: false };
}

/**
 * Creates a structured front-matter validation issue.
 */
function issue(code: string, message: string, line?: number): FrontmatterIssue {
  return { code, ...(line ? { line } : {}), message };
}

/**
 * Narrows an unknown value to a non-array object record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Converts an unknown thrown value into a readable message.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
