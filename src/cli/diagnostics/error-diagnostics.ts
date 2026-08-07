import {
  isSecretLikeKey,
  sanitizeDiagnosticText,
} from "../../platform/diagnostics.js";
import { isDebugMode } from "../debug.js";
import { isDiagnosticValue, isRecord } from "../guards.js";

/**
 * A single allowlisted, non-secret field extracted from an error for the debug
 * diagnostics panel: a human-readable `label` and its already-sanitized
 * `value`. Never carries raw secret material; values pass through
 * `sanitizeDiagnosticText` and secret-like keys are redacted before they reach
 * here.
 */
export interface ErrorDiagnostic {
  /**
   * Dotted path describing where the value came from (e.g. `response.status`,
   * `header.x-request-id`).
   */
  label: string;

  /**
   * The sanitized, display-safe value.
   */
  value: string;
}

/**
 * Extracts a deduped list of allowlisted, non-secret diagnostic fields from an
 * arbitrary (often untrusted) error object for the `--debug` diagnostics panel.
 * Only known-safe keys are read; every value is sanitized and secret-like keys
 * are redacted, so raw secret material never leaves. Walks the error, its
 * OpenRouter metadata, any attached debug payload, and (in debug mode) its
 * `cause`/`error`/`response` nesting.
 */
export function getErrorDiagnostics(error: unknown): ErrorDiagnostic[] {
  const diagnostics: ErrorDiagnostic[] = [];
  const debugMode = isDebugMode();

  if (debugMode && error instanceof Error) {
    diagnostics.push(
      { label: "name", value: error.name },
      { label: "message", value: sanitizeDiagnosticText(error.message) },
    );

    const messageStatus = error.message.match(/\b([45]\d{2})\b/)?.[1];

    if (messageStatus) {
      diagnostics.push({
        label: "httpStatusFromMessage",
        value: messageStatus,
      });
    }
  }

  if (!isRecord(error)) {
    return diagnostics;
  }

  addOpenRouterMetadataDiagnostics(diagnostics, error, "");
  addAttachedDebugDiagnostics(diagnostics, error, "");

  if (debugMode) {
    addSafeObjectDiagnostics(diagnostics, error, "");
    addSafeNestedDiagnostics(diagnostics, error, "cause");
    addSafeNestedDiagnostics(diagnostics, error, "error");
    addSafeNestedDiagnostics(diagnostics, error, "response");
  }

  return dedupeDiagnostics(diagnostics);
}

function addSafeNestedDiagnostics(
  diagnostics: ErrorDiagnostic[],
  value: Record<string, unknown>,
  key: string,
): void {
  const nested = value[key];

  if (!isRecord(nested)) {
    return;
  }

  addSafeObjectDiagnostics(diagnostics, nested, key);
  addOpenRouterMetadataDiagnostics(diagnostics, nested, key);
  addAttachedDebugDiagnostics(diagnostics, nested, key);
}

function addSafeObjectDiagnostics(
  diagnostics: ErrorDiagnostic[],
  value: Record<string, unknown>,
  prefix: string,
): void {
  for (const key of [
    "status",
    "statusCode",
    "statusText",
    "code",
    "type",
    "param",
    "request_id",
    "requestID",
    "lc_error_code",
  ]) {
    const property = value[key];

    if (isDiagnosticValue(property)) {
      diagnostics.push({
        label: prefix ? `${prefix}.${key}` : key,
        value: sanitizeDiagnosticText(String(property)),
      });
    }
  }

  addSafeHeaderDiagnostics(diagnostics, value.headers, prefix);
}

function addAttachedDebugDiagnostics(
  diagnostics: ErrorDiagnostic[],
  value: Record<string, unknown>,
  prefix: string,
): void {
  const debugValue = value.openRouterDebug;

  if (debugValue === undefined || debugValue === null) {
    return;
  }

  diagnostics.push({
    label: prefix ? `${prefix}.openRouterDebug` : "openRouterDebug",
    value: formatDiagnosticMetadataValue(debugValue),
  });
}

function addOpenRouterMetadataDiagnostics(
  diagnostics: ErrorDiagnostic[],
  value: Record<string, unknown>,
  prefix: string,
): void {
  const metadata = value.metadata;

  if (!isRecord(metadata)) {
    return;
  }

  for (const key of ["provider_name", "is_byok", "finish_reason"]) {
    const property = metadata[key];

    if (isDiagnosticValue(property)) {
      diagnostics.push({
        label: prefix ? `${prefix}.metadata.${key}` : `metadata.${key}`,
        value: sanitizeDiagnosticText(String(property)),
      });
    }
  }

  addMetadataValueDiagnostic(diagnostics, metadata, "raw", prefix);
  addPreviousErrorDiagnostics(diagnostics, metadata.previous_errors, prefix);
}

function addMetadataValueDiagnostic(
  diagnostics: ErrorDiagnostic[],
  metadata: Record<string, unknown>,
  key: string,
  prefix: string,
): void {
  const value = metadata[key];

  if (value === undefined || value === null) {
    return;
  }

  diagnostics.push({
    label: prefix ? `${prefix}.metadata.${key}` : `metadata.${key}`,
    value: formatDiagnosticMetadataValue(value),
  });
}

function addPreviousErrorDiagnostics(
  diagnostics: ErrorDiagnostic[],
  previousErrors: unknown,
  prefix: string,
): void {
  if (!Array.isArray(previousErrors)) {
    return;
  }

  previousErrors.slice(0, 5).forEach((previousError, index) => {
    diagnostics.push({
      label: prefix
        ? `${prefix}.metadata.previous_errors.${index}`
        : `metadata.previous_errors.${index}`,
      value: formatDiagnosticMetadataValue(previousError),
    });
  });

  if (previousErrors.length > 5) {
    diagnostics.push({
      label: prefix
        ? `${prefix}.metadata.previous_errors.more`
        : "metadata.previous_errors.more",
      value: `${previousErrors.length - 5} more previous provider errors`,
    });
  }
}

function formatDiagnosticMetadataValue(value: unknown): string {
  if (isDiagnosticValue(value)) {
    return truncateDiagnosticValue(sanitizeDiagnosticText(String(value)));
  }

  return truncateDiagnosticValue(sanitizeDiagnosticText(safeStringify(value)));
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, createDiagnosticJsonReplacer(), 2);
  } catch {
    return String(value);
  }
}

function createDiagnosticJsonReplacer() {
  const seen = new WeakSet<object>();

  return (key: string, value: unknown) => {
    if (isSecretLikeKey(key)) {
      return "[REDACTED]";
    }

    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        return "[Circular]";
      }

      seen.add(value);
    }

    return value;
  };
}

function truncateDiagnosticValue(value: string): string {
  const maxLength = 2_000;
  const normalizedValue = value.trim();

  if (normalizedValue.length <= maxLength) {
    return normalizedValue;
  }

  return `${normalizedValue.slice(0, maxLength - 3)}...`;
}

function addSafeHeaderDiagnostics(
  diagnostics: ErrorDiagnostic[],
  headers: unknown,
  prefix: string,
): void {
  if (!isRecord(headers)) {
    return;
  }

  for (const key of [
    "x-request-id",
    "request-id",
    "openai-processing-ms",
    "cf-ray",
  ]) {
    const value = getHeaderValue(headers, key);

    if (isDiagnosticValue(value)) {
      diagnostics.push({
        label: prefix ? `${prefix}.header.${key}` : `header.${key}`,
        value: sanitizeDiagnosticText(String(value)),
      });
    }
  }
}

function getHeaderValue(
  headers: Record<string, unknown>,
  key: string,
): unknown {
  if (key in headers) {
    return headers[key];
  }

  const matchingKey = Object.keys(headers).find(
    (headerKey) => headerKey.toLowerCase() === key,
  );

  return matchingKey ? headers[matchingKey] : undefined;
}

function dedupeDiagnostics(diagnostics: ErrorDiagnostic[]): ErrorDiagnostic[] {
  const seen = new Set<string>();
  const deduped: ErrorDiagnostic[] = [];

  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.label}:${diagnostic.value}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(diagnostic);
  }

  return deduped;
}
