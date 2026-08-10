/**
 * Shared numeric formatting for the LEDGER report and CLI progress output. Both
 * render metric fractions as percentages and show a dash for an absent value;
 * this module is the single home for that "fraction to percent, dash for absent"
 * rule. Callers choose the decimal precision so the compact live progress line
 * (whole numbers) and the auditable report (one decimal) stay distinct.
 */

/**
 * Render a metric fraction as a percentage string, or a dash when the value is
 * absent. `null` and `undefined` are both treated as absent so callers can pass
 * either the persisted "no adjudicated claim" (`null`) or the "dimension did not
 * occur" (`undefined`) convention.
 *
 * @param value - Fraction between zero and one, or absent.
 * @param decimals - Number of decimal places in the rendered percentage.
 *
 * @returns Percentage text such as `72%` or `72.0%`, or `-` when absent.
 */
export function formatPercent(
  value: number | null | undefined,
  decimals: number,
): string {
  return value === null || value === undefined
    ? "-"
    : `${(value * 100).toFixed(decimals)}%`;
}

/**
 * Render an optional integer count, or a dash when the value is absent.
 *
 * @param value - Count to render, or undefined.
 *
 * @returns The count as text, or `-` when absent.
 */
export function formatCount(value: number | undefined): string {
  return value === undefined ? "-" : String(value);
}

/**
 * Render a mean lifetime in checkpoints, or a dash when the value is absent.
 *
 * @param value - Mean lifetime in checkpoints, or undefined.
 *
 * @returns Lifetime text such as `1.5 checkpoints`, or `-` when absent.
 */
export function formatLifetime(value: number | undefined): string {
  return value === undefined ? "-" : `${value.toFixed(1)} checkpoints`;
}
