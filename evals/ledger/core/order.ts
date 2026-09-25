/**
 * Compare strings using locale-independent code-unit ordering. Used wherever the
 * benchmark needs a stable, reproducible sort that does not depend on the host
 * locale.
 *
 * @param a - First string.
 * @param b - Second string.
 *
 * @returns A negative number, zero, or a positive number for sorting.
 */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
