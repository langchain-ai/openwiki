import {
  ANTHROPIC_API_KEY_ENV_KEY,
  BASETEN_API_KEY_ENV_KEY,
  FIREWORKS_API_KEY_ENV_KEY,
  OPENAI_API_KEY_ENV_KEY,
  OPENAI_COMPATIBLE_API_KEY_ENV_KEY,
  OPENROUTER_API_KEY_ENV_KEY,
} from "./constants.js";

/**
 * Redacts secrets from text before it is shown to the user or written to a log.
 *
 * This is a security boundary: any error message, header value, or provider
 * response body that could contain a credential must pass through here first.
 * It removes (1) the exact values of secrets currently set in the environment
 * and (2) anything matching known key/token shapes (OpenAI/OpenRouter `sk-…`,
 * `Bearer …`, LangSmith `ls…`, and "Incorrect API key provided: …" phrasing).
 */
export function sanitizeDiagnosticText(value: string): string {
  let sanitized = value;

  for (const key of [
    BASETEN_API_KEY_ENV_KEY,
    FIREWORKS_API_KEY_ENV_KEY,
    OPENAI_API_KEY_ENV_KEY,
    OPENAI_COMPATIBLE_API_KEY_ENV_KEY,
    ANTHROPIC_API_KEY_ENV_KEY,
    OPENROUTER_API_KEY_ENV_KEY,
    "LANGSMITH_API_KEY",
  ]) {
    const secret = process.env[key];

    if (secret && secret.length > 0) {
      sanitized = sanitized.split(secret).join(`[REDACTED:${key}]`);
    }
  }

  return sanitized
    .replace(
      /(Incorrect API key provided:\s*)([^\s.]+)/giu,
      "$1[REDACTED:API_KEY]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [REDACTED]")
    .replace(/\bsk-or-v1-[A-Za-z0-9_-]+/gu, "[REDACTED:OPENROUTER_API_KEY]")
    .replace(/\bsk-[A-Za-z0-9_-]+/gu, "[REDACTED:API_KEY]")
    .replace(/\bls[v_][A-Za-z0-9_-]+/gu, "[REDACTED:LANGSMITH_API_KEY]");
}

/**
 * Recognizes an OpenRouter/provider 500 response so a friendlier, actionable
 * message can be shown instead of a raw stack trace.
 */
export function isOpenRouterServerError(
  error: unknown,
  message: string,
): boolean {
  if (isRecord(error)) {
    const status = error.statusCode ?? error.status;
    const name = error instanceof Error ? error.name : null;

    if (
      (status === 500 || status === "500") &&
      (name === "OpenRouterError" || "metadata" in error)
    ) {
      return true;
    }
  }

  return /OpenRouterError/iu.test(String(error)) ||
    /Internal Server Error/iu.test(message)
    ? /\b500\b|Internal Server Error/iu.test(message)
    : false;
}

/**
 * Produces a user-facing error message: a friendly note for provider 500s,
 * otherwise the error's own message with any secrets redacted.
 */
export function getErrorMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "OpenWiki agent run failed.";

  if (isOpenRouterServerError(error, message)) {
    return "OpenRouter/provider returned 500 Internal Server Error. Try retrying or switching models with /model. Run with OPENWIKI_DEBUG=1 to show provider metadata.";
  }

  return sanitizeDiagnosticText(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
