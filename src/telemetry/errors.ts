import type { TelemetryErrorClass } from "./types.js";

/**
 * Maps an unknown error to a closed TelemetryErrorClass. Importantly, this never
 * leaks the message which could contain sensitive information.
 */
export function classifyError(error: unknown): TelemetryErrorClass {
  if (error instanceof Error && error.name === "AbortError") {
    return "aborted";
  }

  const status = extractStatus(error);
  if (status === 401 || status === 403) {
    return "provider_auth";
  }
  if (status === 429) {
    return "provider_rate_limit";
  }

  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/is required to run openwiki/.test(message)) {
    return /base url/.test(message) ? "missing_config" : "missing_credentials";
  }
  if (/invalid model id/.test(message)) {
    return "invalid_model";
  }
  if (/timeout|timed out|etimedout/.test(message)) {
    return "provider_timeout";
  }
  if (/econnrefused|enotfound|network|fetch failed/.test(message)) {
    return "network";
  }

  const code =
    error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  if (code === "ENOENT" || code === "EACCES" || code === "EPERM") {
    return "filesystem";
  }

  return "agent_error";
}

/**
 * Best-effort extraction of an HTTP-ish status from provider SDK errors.
 */
function extractStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const candidate = error as { status?: unknown; statusCode?: unknown };
  const raw = candidate.status ?? candidate.statusCode;

  return typeof raw === "number" ? raw : undefined;
}
