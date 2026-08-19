import type { BackendProtocolV2 } from "deepagents";
import { parse } from "yaml";

/**
 * OKF fields that, when present, must be non-empty string values. `timestamp`
 * is the field OKF v0.2 supersedes with `generated.at`; it stays tolerated
 * because consumers may fall back to it on v0.1 pages (SPEC §13.1).
 */
const OKF_STRING_FIELDS = [
  "type",
  "title",
  "description",
  "resource",
  "timestamp",
];

/**
 * Lifecycle states defined by OKF v0.2 §5.4; an absent `status` means stable.
 */
const OKF_STATUS_VALUES = ["draft", "stable", "deprecated"];

/**
 * Matches the absolute `YYYY-MM-DD` date `stale_after` requires (§5.5).
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * Extension field flagging front matter OpenWiki derived deterministically.
 */
export const OPENWIKI_GENERATED_FIELD = "openwiki_generated";

/**
 * Extension field marking a page whose translation is still owed, carrying the
 * BCP-47 target language (for example `"zh-CN"`). Written and cleared only by the
 * translation middleware; the deterministic OKF pass merely preserves it.
 */
export const OPENWIKI_TRANSLATION_PENDING_FIELD =
  "openwiki_translation_pending";

/**
 * Extension fields that must survive a deterministic front-matter regeneration.
 *
 * When a page fails OKF validation its front matter is rebuilt from a minimal
 * derived block, which would otherwise drop every extension field. Fields listed
 * here are carried across that rebuild so control markers are not lost when a
 * page happens to be both non-conformant and, say, pending translation.
 */
const PRESERVED_EXTENSION_FIELDS = [OPENWIKI_TRANSLATION_PENDING_FIELD];

/**
 * OKF v0.2 provenance/trust/lifecycle families (SPEC §5) that must survive the
 * deterministic type-less rebuild. Unlike {@link PRESERVED_EXTENSION_FIELDS}
 * these hold structured mappings or lists rather than scalar strings, so they
 * are carried across verbatim as whole raw lines rather than re-quoted.
 *
 * `generated` is code-owned (see {@link setGeneratedEvent}); listing it here
 * keeps a deterministically stamped provenance event from being discarded when
 * a page also happens to trip the type-less repair path.
 */
const PRESERVED_STRUCTURED_FIELDS = ["generated"];

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
  validateTrustFamilies(fields, issues);

  return issues.length === 0 ? { valid: true } : { issues, valid: false };
}

/**
 * Validates the optional OKF v0.2 provenance, trust, and lifecycle families
 * (SPEC §5) when present. Only the shape OKF specifies is checked; extra keys
 * inside entries stay tolerated so producer extensions survive round trips.
 */
function validateTrustFamilies(
  fields: Record<string, unknown>,
  issues: FrontmatterIssue[],
): void {
  if (Object.hasOwn(fields, "generated") && !isActorEvent(fields.generated)) {
    issues.push(
      issue(
        "invalid_generated",
        "Field `generated` must be a mapping with a non-empty string `by` (actor) and an optional string `at` (ISO 8601 datetime).",
      ),
    );
  }
  if (Object.hasOwn(fields, "verified")) {
    // §5.2: a single verifier may be a bare mapping; read it as a one-element list.
    const events = Array.isArray(fields.verified)
      ? fields.verified
      : [fields.verified];
    if (!events.every(isActorEvent)) {
      issues.push(
        issue(
          "invalid_verified",
          "Field `verified` must be a `{by, at}` mapping or a YAML list of them, each with a non-empty string `by` (actor).",
        ),
      );
    }
  }
  if (
    Object.hasOwn(fields, "sources") &&
    (!Array.isArray(fields.sources) ||
      fields.sources.some(
        (entry) => !isRecord(entry) || !isNonEmptyString(entry.resource),
      ))
  ) {
    issues.push(
      issue(
        "invalid_sources",
        "Field `sources` must be a YAML list of mappings, each with a non-empty string `resource`.",
      ),
    );
  }
  if (
    Object.hasOwn(fields, "status") &&
    (typeof fields.status !== "string" ||
      !OKF_STATUS_VALUES.includes(fields.status))
  ) {
    issues.push(
      issue(
        "invalid_status",
        "Field `status` must be one of `draft`, `stable`, or `deprecated`.",
      ),
    );
  }
  if (
    Object.hasOwn(fields, "stale_after") &&
    (typeof fields.stale_after !== "string" ||
      !ISO_DATE.test(fields.stale_after))
  ) {
    issues.push(
      issue(
        "invalid_stale_after",
        "Field `stale_after` must be an absolute `YYYY-MM-DD` date.",
      ),
    );
  }
}

/**
 * Narrows a value to an OKF `{by, at}` event: a mapping whose `by` is a
 * non-empty actor string and whose `at`, when present, is a non-empty string.
 */
function isActorEvent(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.by) &&
    (!Object.hasOwn(value, "at") || isNonEmptyString(value.at))
  );
}

/**
 * Reports whether a value is a non-empty, non-blank string.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
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
 * Reads a single front-matter field's string value, or undefined when the field
 * is absent, the block is unparseable, or the value is not a string.
 */
export function readFrontmatterField(
  content: string,
  key: string,
): string | undefined {
  const value = parseFrontmatterFields(content)?.[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Sets or replaces a single scalar field in a page's front matter, preserving
 * every other line byte-for-byte.
 *
 * This deliberately edits the raw block rather than parsing and re-rendering,
 * because {@link renderFrontmatter} only knows a fixed set of fields and would
 * drop producer extensions on a round trip. When the page has no front-matter
 * block, a minimal one holding just this field is prepended. The value is
 * JSON-quoted so colons and other YAML-significant characters stay safe.
 */
export function setFrontmatterField(
  content: string,
  key: string,
  value: string,
): string {
  const line = `${key}: ${JSON.stringify(value)}`;
  const { block, body } = splitFrontmatter(content);
  if (block === undefined) {
    return `---\n${line}\n---\n\n${content}`;
  }

  const lines = block.split("\n");
  const index = lines.findIndex((current) => isFieldLine(current, key));
  if (index === -1) {
    lines.push(line);
  } else {
    lines[index] = line;
  }
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

/**
 * Stamps the code-owned OKF `generated` provenance event on a page (SPEC §5.1),
 * setting or replacing a `generated: {by, at}` flow mapping and preserving every
 * other front-matter line byte-for-byte.
 *
 * `generated` is a mapping, not a scalar, so it cannot go through
 * {@link setFrontmatterField}. The value is emitted as a single-line flow
 * mapping with JSON-quoted members so an actor or datetime containing a colon
 * stays valid YAML. When the page has no front-matter block, a minimal one
 * holding just this field is prepended.
 *
 * `at` is optional so the same helper can carry a bare `{by}` event; callers
 * that record a run time pass it, and it is emitted only when present.
 */
export function setGeneratedEvent(
  content: string,
  by: string,
  at?: string,
): string {
  const members =
    at === undefined
      ? `by: ${JSON.stringify(by)}`
      : `by: ${JSON.stringify(by)}, at: ${JSON.stringify(at)}`;
  const line = `generated: {${members}}`;
  const { block, body } = splitFrontmatter(content);
  if (block === undefined) {
    return `---\n${line}\n---\n\n${content}`;
  }

  const lines = block.split("\n");
  const index = lines.findIndex((current) => isFieldLine(current, "generated"));
  if (index === -1) {
    lines.push(line);
  } else {
    lines[index] = line;
  }
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

/**
 * Reports whether two documents have the same concept body, ignoring their
 * front-matter blocks and treating a run of whitespace as equal to a single
 * space. This is the "meaningful change" test that gates {@link setGeneratedEvent}:
 * a write that only reshuffles front matter or reflows whitespace does not bump
 * the recorded change time.
 */
export function conceptBodiesEqual(before: string, after: string): boolean {
  return normalizeBody(before) === normalizeBody(after);
}

/**
 * Strips a document's front matter and collapses whitespace so two bodies that
 * differ only in spacing or blank lines compare equal.
 */
function normalizeBody(content: string): string {
  return splitFrontmatter(content).body.replace(/\s+/gu, " ").trim();
}

/**
 * Removes a single field from a page's front matter, preserving every other line
 * byte-for-byte, and returns the content unchanged when the field is absent. If
 * the field was the block's only line, the now-empty block is dropped entirely.
 */
export function removeFrontmatterField(content: string, key: string): string {
  const { block, body } = splitFrontmatter(content);
  if (block === undefined) return content;

  const kept = block.split("\n").filter((line) => !isFieldLine(line, key));
  if (kept.length === block.split("\n").length) return content;
  if (kept.length === 0) return body.replace(/^\r?\n/u, "");
  return `---\n${kept.join("\n")}\n---\n${body}`;
}

/**
 * Returns the raw front-matter line declaring the given top-level key, verbatim
 * and including any inline flow mapping or list, or undefined when the field is
 * absent or the block is unusable. Used to carry a structured field across the
 * deterministic rebuild without parsing and re-rendering it.
 */
function rawFrontmatterLine(content: string, key: string): string | undefined {
  const { block } = splitFrontmatter(content);
  if (block === undefined) return undefined;
  return block.split("\n").find((line) => isFieldLine(line, key));
}

/**
 * Appends a raw front-matter line to a page's block verbatim, preserving every
 * existing line. A page with no block is returned unchanged, since the rebuild
 * path always constructs one before calling this.
 */
function appendFrontmatterLine(content: string, rawLine: string): string {
  const { block, body } = splitFrontmatter(content);
  if (block === undefined) return content;
  return `---\n${block}\n${rawLine}\n---\n${body}`;
}

/**
 * Reports whether a raw front-matter line declares the given top-level key.
 */
function isFieldLine(line: string, key: string): boolean {
  return new RegExp(`^${escapeRegExp(key)}\\s*:`, "u").test(line);
}

/**
 * Escapes a string for safe interpolation into a regular expression.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
 *
 * `conceptType` is the localized fallback stamped as the `type`; it defaults to
 * English "Reference" for callers that do not localize.
 */
export function deriveMinimalFrontmatter(
  body: string,
  filePath: string,
  conceptType: string = "Reference",
): DerivedFrontmatter {
  return {
    type: conceptType,
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
 *
 * `conceptType` is the localized fallback used for a repaired page's `type`; it
 * defaults to English "Reference" for callers that do not localize.
 */
export function normalizeConceptContent(
  content: string,
  filePath: string,
  conceptType: string = "Reference",
): { changed: boolean; content: string } {
  if (hasUsableConceptType(content)) {
    return { changed: false, content };
  }
  const { body } = splitFrontmatter(content);
  const derived = deriveMinimalFrontmatter(body, filePath, conceptType);
  const front = renderFrontmatter(derived, { generated: true });
  let rebuilt = `${front}${body.replace(/^\s+/u, "")}`;
  for (const field of PRESERVED_EXTENSION_FIELDS) {
    const value = readFrontmatterField(content, field);
    if (value !== undefined) {
      rebuilt = setFrontmatterField(rebuilt, field, value);
    }
  }
  for (const field of PRESERVED_STRUCTURED_FIELDS) {
    const line = rawFrontmatterLine(content, field);
    if (line !== undefined) {
      rebuilt = appendFrontmatterLine(rebuilt, line);
    }
  }
  return { changed: true, content: rebuilt };
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
