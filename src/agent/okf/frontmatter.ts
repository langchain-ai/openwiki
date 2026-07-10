import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Parsed frontmatter mapping. A genuine alias to a utility type, so `type`.
 */
export type Frontmatter = Record<string, unknown>;

/**
 * A markdown document split into its frontmatter data and body text.
 */
export interface ParsedDocument {
  /**
   * Parsed frontmatter key/values (empty when absent or malformed).
   */
  data: Frontmatter;

  /**
   * The markdown body after the frontmatter block.
   */
  body: string;
}

/**
 * Line-anchored frontmatter matcher: the closing fence must be a "---" on its
 * own line, so a "---" inside a value can never truncate the block.
 */
export const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n?/u;

/**
 * Managed keys are serialized in this order for byte-stable output; unknown
 * (producer-added) keys are preserved and appended after these.
 */
const FRONTMATTER_KEY_ORDER = [
  "type",
  "title",
  "description",
  "resource",
  "tags",
  "timestamp",
];

/**
 * Splits a leading frontmatter block from the body. Uses `yaml.parse` (safe: no
 * custom tags, no code execution). Malformed or absent frontmatter yields empty
 * data so code can rebuild it; the body is preserved.
 */
export function parseFrontmatter(raw: string): ParsedDocument {
  const match = FRONTMATTER_PATTERN.exec(raw);

  if (!match) {
    return { data: {}, body: raw };
  }

  const body = raw.slice(match[0].length);

  try {
    const parsed = parseYaml(match[1] ?? "") as unknown;

    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return { data: parsed as Frontmatter, body };
    }
  } catch {
    // Malformed frontmatter → treat as absent; code rebuilds it.
  }

  return { data: {}, body };
}

/**
 * Serializes frontmatter + body with a stable key order and exactly one blank
 * line between them, always ending in a newline. Deterministic for a given
 * input, which is what makes the pass idempotent.
 */
export function serializeFrontmatter(data: Frontmatter, body: string): string {
  const ordered: Frontmatter = {};

  for (const key of FRONTMATTER_KEY_ORDER) {
    if (data[key] !== undefined) {
      ordered[key] = data[key];
    }
  }
  for (const key of Object.keys(data)) {
    if (!FRONTMATTER_KEY_ORDER.includes(key) && data[key] !== undefined) {
      ordered[key] = data[key];
    }
  }

  const yaml = stringifyYaml(ordered).trimEnd();

  return `---\n${yaml}\n---\n\n${ensureTrailingNewline(stripLeadingBlankLines(body))}`;
}

/**
 * Type guard for a present, non-blank string.
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Removes leading blank lines from a body.
 */
export function stripLeadingBlankLines(body: string): string {
  return body.replace(/^\n+/u, "");
}

/**
 * Ensures the text ends with exactly one trailing newline.
 */
export function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}
