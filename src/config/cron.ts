/**
 * The five cron fields, in order, used to label and index the segmented cron
 * editor.
 */
export const CRON_FIELD_LABELS = ["minute", "hour", "day", "month", "weekday"];

/**
 * Splits a cron expression into its five fields, falling back to
 * `fallbackExpression` when the expression is blank and padding missing fields
 * with empty strings.
 */
export function getCronFields(
  expression: string,
  fallbackExpression: string,
): string[] {
  const source =
    expression.trim().length > 0 ? expression.trim() : fallbackExpression;
  const fields = source.split(/\s+/u);

  return CRON_FIELD_LABELS.map((_, index) => fields[index] ?? "");
}

/**
 * Interprets pasted text as cron fields: whitespace-separated tokens are each
 * sanitized, and a bare five-character run of digits/`*` is split into single
 * fields. Returns an empty array when the paste is not field-shaped.
 */
export function parseCronFieldPaste(inputValue: string): string[] {
  if (inputValue.trim().length === 0) {
    return [];
  }

  if (/\s/u.test(inputValue)) {
    return inputValue
      .trim()
      .split(/\s+/u)
      .map((field) => sanitizeCronInputChunk(field))
      .filter((field) => field.length > 0);
  }

  const compactValue = sanitizeCronInputChunk(inputValue);

  if (/^[0-9*]{5}$/u.test(compactValue)) {
    return compactValue.split("");
  }

  return [];
}

/**
 * Strips characters that are never valid in a cron field, keeping digits,
 * letters, and the cron operators (`* , / ? # L W . -`).
 */
export function sanitizeCronInputChunk(value: string): string {
  return value.replace(/[^A-Za-z0-9*,/?#LW.-]/gu, "");
}
