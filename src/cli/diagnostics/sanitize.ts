/**
 * Collapses a value to a single-line, control-character-free string that is
 * safe to print in a terminal header, truncating with an ellipsis past
 * `maxLength`. Strips control characters first (so an escape sequence in an
 * untrusted value cannot rewrite the line), then folds any remaining
 * whitespace runs to single spaces.
 *
 * @param maxLength - Maximum rendered length before an ellipsis is appended.
 *
 * @default 80 - the header width the CLI renders at.
 */
export function sanitizeHeaderValue(value: string, maxLength = 80): string {
  const compactValue = stripControlCharacters(value)
    .replace(/[^\S\n]+/gu, " ")
    .replace(/[\r\n\t]/gu, " ")
    .trim();

  if (compactValue.length <= maxLength) {
    return compactValue;
  }

  return `${compactValue.slice(0, Math.max(0, maxLength - 3))}...`;
}

/**
 * Replaces every C0/C1 control character (and any code point that cannot be
 * read) with a space, leaving printable text intact. Prevents terminal escape
 * sequences embedded in untrusted values from moving the cursor or rewriting
 * output when the value is displayed.
 */
export function stripControlCharacters(value: string): string {
  let sanitized = "";

  for (const character of value) {
    const codePoint = character.codePointAt(0);

    if (
      codePoint === undefined ||
      codePoint <= 31 ||
      (codePoint >= 127 && codePoint <= 159)
    ) {
      sanitized += " ";
      continue;
    }

    sanitized += character;
  }

  return sanitized;
}
