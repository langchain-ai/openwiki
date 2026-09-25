/**
 * Shared helpers for parsing connector configuration.
 *
 * Connector config comes from on-disk JSON that a user can hand-edit, so a field
 * declared as an array may arrive as a scalar, contain non-string entries, or
 * hold blank/whitespace values. These helpers coerce such input into predictable
 * shapes before it reaches ingestion logic.
 */

/**
 * Coerce an unknown config value into a clean list of strings: only non-empty
 * strings are kept, each trimmed. A non-array, or an array with non-string or
 * blank entries, yields an empty list rather than throwing.
 */
export function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter(
          (item): item is string =>
            typeof item === "string" && item.trim().length > 0,
        )
        .map((item) => item.trim())
    : [];
}
