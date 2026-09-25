/**
 * Narrows an unknown value to a non-null object with string keys. Used as the
 * entry guard before indexing into arbitrary (often untrusted) error or tool
 * payloads, so a null or primitive is rejected before any property access.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * True when a value is a scalar that is safe to render directly as a diagnostic
 * string (string, number, or boolean). Objects, arrays, and nullish values are
 * excluded so callers route them through the structured formatter instead of
 * stringifying them blindly.
 */
export function isDiagnosticValue(
  value: unknown,
): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}
