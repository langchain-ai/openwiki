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
 * Resolves an effective fetch limit from an optional override and a default.
 */
export function clampLimit(
  override: number | undefined,
  fallback: number | undefined,
  ceiling: number,
): number {
  const requested = override ?? fallback ?? ceiling;
  return Math.min(ceiling, Math.max(1, Math.floor(requested)));
}
