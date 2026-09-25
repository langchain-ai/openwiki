/**
 * Renders a masked one-line summary of a captured secret, surfacing only its
 * length so the raw value is never echoed to the UI.
 */
export function formatSecretInputSummary(value: string): string {
  return value.length === 0 ? "[empty]" : `[hidden, ${value.length} chars]`;
}
