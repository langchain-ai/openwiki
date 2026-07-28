import type { TelemetryErrorClass, TelemetryErrorStage } from "./types.js";

/**
 * Provider-native error codes we recognize, mapped to a class. Read internally
 * only to disambiguate otherwise-identical statuses (a context-limit 400 vs any
 * other 400); the code string itself is never emitted (Open 4a). Anything not on
 * this list is ignored, so the envelope stays closed.
 */
const PROVIDER_ERROR_CODES: Readonly<Record<string, TelemetryErrorClass>> = {
  context_length_exceeded: "provider_context_limit",
  string_above_max_length: "provider_context_limit",
  rate_limit_exceeded: "provider_rate_limit",
  insufficient_quota: "provider_quota_exceeded",
  billing_hard_limit_reached: "provider_quota_exceeded",
  invalid_api_key: "provider_auth",
  authentication_error: "provider_auth",
  permission_error: "provider_auth",
  overloaded_error: "provider_overloaded",
  content_policy_violation: "provider_content_filter",
  content_filter: "provider_content_filter",
};

/**
 * Maps an unknown error to a closed {@link TelemetryErrorClass}. Priority runs
 * most-specific to least: abort, recognized provider code, HTTP status, tool
 * shape, message regexes, filesystem code, then the single `agent_error`
 * catch-all. Never leaks the message: it is read to test regexes in-process, but
 * only an enum member is ever returned.
 */
export function classifyError(error: unknown): TelemetryErrorClass {
  if (error instanceof Error && error.name === "AbortError") {
    return "aborted";
  }

  const providerCode = extractProviderErrorCode(error);
  if (providerCode && providerCode in PROVIDER_ERROR_CODES) {
    return PROVIDER_ERROR_CODES[providerCode];
  }

  const status = extractStatus(error);
  if (status === 401 || status === 403) {
    return "provider_auth";
  }
  if (status === 429) {
    return "provider_rate_limit";
  }
  if (status === 529 || status === 503) {
    return "provider_overloaded";
  }
  if (status !== undefined && status >= 500 && status < 600) {
    return "provider_server_error";
  }

  if (error instanceof Error && /tool/iu.test(error.name)) {
    return "tool_error";
  }

  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/is required to run openwiki/u.test(message)) {
    return /base url/u.test(message) ? "missing_config" : "missing_credentials";
  }
  if (/invalid model id/u.test(message)) {
    return "invalid_model";
  }
  if (
    /context length|maximum context|too many tokens|context window/u.test(
      message,
    )
  ) {
    return "provider_context_limit";
  }
  if (/quota|insufficient_quota|billing/u.test(message)) {
    return "provider_quota_exceeded";
  }
  if (/timeout|timed out|etimedout/u.test(message)) {
    return "provider_timeout";
  }
  if (
    /econnrefused|enotfound|network|fetch failed|econnreset|eai_again/u.test(
      message,
    )
  ) {
    return "network";
  }
  if (/content policy|content filter|content_filter|refus/u.test(message)) {
    return "provider_content_filter";
  }
  if (/could not parse|invalid json|schema/u.test(message)) {
    return "output_invalid";
  }

  const code =
    error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  if (code === "ENOENT" || code === "EACCES" || code === "EPERM") {
    return "filesystem";
  }

  return "agent_error";
}

/**
 * Best-effort extraction of an HTTP-ish status from a provider SDK error. Reads
 * the common shapes, including the nested `response.status` some clients use.
 */
export function extractStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown } | null;
  };
  const raw =
    candidate.status ?? candidate.statusCode ?? candidate.response?.status;

  return typeof raw === "number" ? raw : undefined;
}

/**
 * Reads the provider's own error code from the common SDK shapes, lowercased. Used
 * only to pick a class; the return value is never emitted.
 */
function extractProviderErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const candidate = error as {
    code?: unknown;
    type?: unknown;
    error?: { code?: unknown; type?: unknown } | null;
  };
  const raw =
    candidate.code ??
    candidate.type ??
    candidate.error?.code ??
    candidate.error?.type;

  return typeof raw === "string" ? raw.trim().toLowerCase() : undefined;
}

/**
 * Non-enumerable symbol tag carrying the pipeline stage a failure occurred in.
 * Non-enumerable so it never serializes into a telemetry payload or a JSON dump.
 */
const ERROR_STAGE = Symbol.for("openwiki.telemetry.errorStage");

/**
 * Stamps `stage` onto `error` if it does not already carry one (first tag wins,
 * so the innermost/earliest stage is preserved as the error unwinds). No-op for
 * non-objects.
 */
export function tagErrorStage(
  error: unknown,
  stage: TelemetryErrorStage,
): void {
  if (typeof error !== "object" || error === null) {
    return;
  }

  const target = error as Record<symbol, unknown>;
  if (target[ERROR_STAGE] !== undefined) {
    return;
  }

  Object.defineProperty(error, ERROR_STAGE, {
    value: stage,
    enumerable: false,
    configurable: true,
    writable: false,
  });
}

/**
 * Reads the stage tag off an error, or undefined if it was never tagged. An
 * untagged failure emits no stage (the sender omits the field) rather than a
 * named "unknown" bucket.
 */
export function readErrorStage(
  error: unknown,
): TelemetryErrorStage | undefined {
  if (typeof error === "object" && error !== null) {
    const tag = (error as Record<symbol, unknown>)[ERROR_STAGE];
    if (typeof tag === "string") {
      return tag as TelemetryErrorStage;
    }
  }

  return undefined;
}

/**
 * Runs `fn`, tagging any thrown error with `stage` before it propagates. The one
 * call the run pipeline uses to bracket a stage.
 */
export async function inStage<T>(
  stage: TelemetryErrorStage,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    tagErrorStage(error, stage);
    throw error;
  }
}

/**
 * Synchronous {@link inStage}, for the synchronous build steps (`createModel`,
 * `createDeepAgent`) that can throw before any promise is created.
 */
export function inStageSync<T>(stage: TelemetryErrorStage, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    tagErrorStage(error, stage);
    throw error;
  }
}

/**
 * The single call the failure path uses: class, stage, and status in one object,
 * ready to spread into the run facts.
 */
export function describeErrorForTelemetry(error: unknown): {
  errorClass: TelemetryErrorClass;
  errorStage: TelemetryErrorStage | undefined;
  httpStatus: number | undefined;
} {
  return {
    errorClass: classifyError(error),
    errorStage: readErrorStage(error),
    httpStatus: extractStatus(error),
  };
}
