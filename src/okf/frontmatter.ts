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
 * Minimal OKF fields OpenWiki can derive from a page body. Only `type` (the sole
 * required OKF field) and a `title` are derived; the optional `description` is
 * left for the agent to supply, since a code-guessed one is usually poor.
 */
interface DerivedFrontmatter {
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

/**
 * Splits a Markdown document into its leading front-matter block and body.
 */
export function splitFrontmatter(content: string): {
  block?: string;
  body: string;
} {
  const match = FRONTMATTER_BLOCK.exec(content);
  if (!match) return { body: content };
  return { block: match[1], body: content.slice(match[0].length) };
}

/**
 * Parses the front-matter block into a field map, or undefined if unusable.
 */
export function parseFrontmatterFields(
  content: string,
): Record<string, unknown> | undefined {
  const { block } = splitFrontmatter(content);
  if (block === undefined) return undefined;

  let fields: unknown;
  try {
    fields = parse(`\n${block}`, {
      maxAliasCount: 100,
      schema: "core",
      uniqueKeys: true,
    }) as unknown;
  } catch {
    return undefined;
  }
  return fields !== null && typeof fields === "object" && !Array.isArray(fields)
    ? (fields as Record<string, unknown>)
    : undefined;
}

/**
 * Returns the text of the first ATX H1 in a body, if any.
 */
function firstHeading(body: string): string | undefined {
  const match = /^#\s+(.+?)\s*$/mu.exec(body);
  return match ? match[1].trim() : undefined;
}

/**
 * Builds a human-readable title from a Markdown filename.
 */
function titleFromFilename(filePath: string): string {
  const base = filePath.replace(/^.*\//u, "").replace(/\.md$/iu, "");
  const spaced = base.replace(/[-_]+/gu, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : base;
}

/**
 * Derives minimal OKF fields from a page body and its path.
 */
export function deriveMinimalFrontmatter(
  body: string,
  filePath: string,
): DerivedFrontmatter {
  return {
    type: "Reference",
    title: firstHeading(body) ?? titleFromFilename(filePath),
  };
}

/**
 * Renders an OKF front-matter block, flagging code-derived metadata.
 */
export function renderFrontmatter(
  fields: DerivedFrontmatter,
  options: { generated: boolean },
): string {
  const lines = [
    `type: ${JSON.stringify(fields.type)}`,
    `title: ${JSON.stringify(fields.title)}`,
  ];
  if (options.generated) lines.push(`${OPENWIKI_GENERATED_FIELD}: true`);
  return `---\n${lines.join("\n")}\n---\n\n`;
}

/**
 * Guarantees a page has valid OKF front matter without destroying good data.
 *
 * Rule: if the front matter parses and has a non-empty `type`, the page is left
 * unchanged. Otherwise (no front matter, unparseable YAML, or a missing `type`)
 * its front matter is replaced with a minimal block derived from the body and
 * tagged `openwiki_generated` for later agent review.
 *
 * Pages that already have a `type` are kept even when optional fields like
 * `title` are junk, so an author's `type` and custom fields are never
 * overwritten; the index generator already ignores unusable optional fields.
 * Never throws. Returns the new content and whether it changed.
 */
export function normalizeConceptContent(
  content: string,
  filePath: string,
): { changed: boolean; content: string } {
  if (hasUsableConceptType(content)) {
    return { changed: false, content };
  }
  const { body } = splitFrontmatter(content);
  const derived = deriveMinimalFrontmatter(body, filePath);
  const front = renderFrontmatter(derived, { generated: true });
  return { changed: true, content: `${front}${body.replace(/^\s+/u, "")}` };
}

/**
 * Reports whether a page already declares a usable OKF `type`, meaning its
 * front matter parses and `type` is a non-empty string.
 */
function hasUsableConceptType(content: string): boolean {
  const fields = parseFrontmatterFields(content);
  return (
    fields !== undefined &&
    typeof fields.type === "string" &&
    fields.type.trim() !== ""
  );
}
