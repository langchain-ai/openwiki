/**
 * Shared bounds for deterministic connector ingestion.
 *
 * Every connector pull is clamped in two dimensions: how far back it may look
 * (the window) and how many items it may fetch per stream (the limit).
 * Centralizing the clamps makes "how much work can one ingestion run do" a
 * single auditable policy instead of a convention copied between sources.
 */

/**
 * Ingestion window applied when the caller does not provide one (one day).
 */
const DEFAULT_WINDOW_HOURS = 24;

/**
 * Widest window a single ingestion run may cover (one week).
 */
const MAX_WINDOW_HOURS = 168;

/**
 * Normalizes a requested ingestion window to a whole number of hours between
 * one hour and one week. Missing or invalid values fall back to the 24-hour
 * default used by scheduled ingestion.
 */
export function normalizeWindowHours(windowHours: number | undefined): number {
  if (typeof windowHours !== "number" || !Number.isFinite(windowHours)) {
    return DEFAULT_WINDOW_HOURS;
  }
  return Math.max(1, Math.min(MAX_WINDOW_HOURS, Math.trunc(windowHours)));
}

/**
 * Resolves an effective per-stream item limit from the per-run option, the
 * connector config, and a hard maximum in that order. The result is always
 * a whole number between 1 and the hard maximum, so callers can pass it
 * straight into an API request or slice call.
 */
export function clampLimit(
  optionLimit: number | undefined,
  configLimit: number | undefined,
  max: number,
): number {
  const limit = optionLimit ?? configLimit ?? max;
  return Math.max(1, Math.min(max, Math.trunc(limit)));
}
