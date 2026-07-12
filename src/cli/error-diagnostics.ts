import { sanitizeDiagnosticText } from "../diagnostics.js";
import { isDebugMode } from "../ui/format.js";

/**
 * A single labeled diagnostic line describing an error, for display or logs.
 */
export interface ErrorDiagnostic {
  /**
   * Short label naming the field (e.g. `status`, `header.cf-ray`).
   */
  readonly label: string;

  /**
   * The field's value, already redacted for display.
   */
  readonly value: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Builds the labeled diagnostic lines for an error. In debug mode it includes
 * the error name/message and any HTTP status parsed from the message; it always
 * includes OpenRouter provider metadata and attached debug info when present.
 * All values are redacted before inclusion, and the result is deduplicated.
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

function isSecretLikeKey(key: string): boolean {
  return /api[-_]?key|authorization|bearer|token|secret|password/iu.test(key);
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

function isDiagnosticValue(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/**
 * Writes an error's diagnostics to stderr under an "Error Diagnostics" heading.
 * No-ops when there are no diagnostics to report.
 */
export function writePrintErrorDiagnostics(error: unknown): void {
  const diagnostics = getErrorDiagnostics(error);

  if (diagnostics.length === 0) {
    return;
  }

  process.stderr.write("\nError Diagnostics\n");

  for (const diagnostic of diagnostics) {
    process.stderr.write(`${diagnostic.label}: ${diagnostic.value}\n`);
  }
}
