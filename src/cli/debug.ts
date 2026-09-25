/**
 * True when verbose debug output is enabled via `OPENWIKI_DEBUG=1`. Gates the
 * error-diagnostics panel and other developer-facing detail that is hidden in
 * normal runs.
 */
export function isDebugMode(): boolean {
  return process.env.OPENWIKI_DEBUG === "1";
}

/**
 * True when credential diagnostics should be shown: either full debug mode, or
 * the narrower `OPENWIKI_DEBUG_CREDENTIALS=1` opt-in for credential-only detail.
 */
export function shouldShowCredentialDiagnostics(): boolean {
  return isDebugMode() || process.env.OPENWIKI_DEBUG_CREDENTIALS === "1";
}
