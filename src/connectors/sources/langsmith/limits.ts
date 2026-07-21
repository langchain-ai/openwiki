/**
 * Clamps the ingestion window to a sane range, defaulting to 24 hours.
 */
export function normalizeWindowHours(windowHours: number | undefined): number {
  if (windowHours === undefined || !Number.isFinite(windowHours)) {
    return 24;
  }
  return Math.min(24 * 7, Math.max(1, Math.floor(windowHours)));
}

/**
 * Resolves an effective per-project trace budget from an optional override and a
 * default, clamped to a hard ceiling so a bad config cannot request a firehose.
 */
export function clampTraces(
  value: number | undefined,
  fallback: number,
): number {
  const requested = value ?? fallback;
  if (!Number.isFinite(requested)) {
    return fallback;
  }
  return Math.min(50, Math.max(1, Math.floor(requested)));
}
