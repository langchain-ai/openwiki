import type {
  TelemetryErrorClass,
  TelemetryErrorOwner,
  TelemetryErrorStage,
} from "./types.js";

/**
 * The hardcoded `errorDetail` allowlist for each closed family: the exact set of
 * detail values that family may emit. This is the anonymity spine for the detail
 * property. Any observed detail not present for its family is dropped to undefined
 * (see {@link normalizeErrorDetail}), so only these hand-named words ever leave the
 * process. Families with no detail split map to an empty list.
 *
 * Two families are deliberately absent (`connector_error`, `tool_error`): their
 * detail is a registry id, not a fixed word, and is validated at its tag site
 * against the connector/tool registry instead (see {@link OPEN_DETAIL_CLASSES}).
 */
const FIXED_ERROR_DETAILS: Readonly<
  Record<
    Exclude<TelemetryErrorClass, "connector_error" | "tool_error">,
    readonly string[]
  >
> = {
  config_error: [
    "missing_credentials",
    "missing_base_url",
    "missing_secret_key",
    "missing_region",
    "invalid_model",
  ],
  filesystem_error: ["not_found", "permission", "no_space"],
  provider_error: [
    "auth",
    "rate_limit",
    "overloaded",
    "server_error",
    "timeout",
    "quota_exceeded",
    "content_filter",
  ],
  network_error: ["dns", "refused", "reset", "unreachable"],
  build_error: ["run_context", "snapshot", "model", "agent", "stream_open"],
  okf_error: ["migrate", "index_sync", "mermaid"],
  checkpointer_error: ["create", "persist", "chmod"],
  output_error: ["json_parse", "schema"],
  // No detail split: the family is the whole signal.
  context_limit_error: [],
  // The residual bucket's detail is not a fixed word: it is the innermost error's own
  // name, gated by the identifier allowlist in `normalizeErrorDetail`, not this list.
  agent_error: [],
  aborted: [],
};

/**
 * Families whose detail is a registry id (the connector id or the tool name) rather
 * than a fixed word. Their detail is validated at the tag site against the known
 * connector/tool set, which is the same closed set already emitted as `connector_*`
 * booleans, so it is trusted here without a static allowlist.
 */
const OPEN_DETAIL_CLASSES: ReadonlySet<TelemetryErrorClass> = new Set([
  "connector_error",
  "tool_error",
]);

/**
 * A bare code identifier: an ASCII letter, then letters/digits with single interior
 * underscores (e.g. `TypeError`, `AI_APICallError`, `OUTPUT_PARSING_FAILURE`). The
 * anonymity gate for any error-name-shaped value: a `.name` or `constructor.name` set
 * to a template string carrying a path, URL, space, or user value fails this and is
 * dropped, keeping the envelope closed. Leading, trailing, and doubled underscores
 * are rejected so nothing but a plain identifier survives.
 */
const SAFE_ERROR_IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*$/u;

/**
 * Whether `value` is a bare code identifier safe to emit: a string of at most 64
 * characters matching {@link SAFE_ERROR_IDENTIFIER}. The length bound caps how much a
 * single name can weigh and closes the door on a giant synthesized name. The one gate
 * every error identifier passes through before it can leave the process, whether it
 * is read from `.name`, `constructor.name`, or the residual `agent_error` detail.
 *
 * @param value - The candidate identifier, or any non-string value.
 * @returns True only for an allowlisted bare identifier.
 */
export function isSafeErrorIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    SAFE_ERROR_IDENTIFIER.test(value)
  );
}

/**
 * Provider-error details that are really the user's key or account, not a transient
 * provider fault, so they route to `environment` instead of `provider`.
 */
const PROVIDER_ENVIRONMENT_DETAILS: ReadonlySet<string> = new Set([
  "auth",
  "quota_exceeded",
]);

/**
 * Network-error details that are the user's machine or network, not the path to the
 * provider, so they route to `environment` instead of `provider`.
 */
const NETWORK_ENVIRONMENT_DETAILS: ReadonlySet<string> = new Set([
  "dns",
  "refused",
]);

/**
 * Validates an observed `detail` against its family's allowlist, returning it only
 * when legal and undefined otherwise. This is the runtime guarantee behind the
 * detail property's anonymity: a fixed-family detail must be on the family's
 * hardcoded list; an open-family detail (connector/tool id) is trusted as a
 * non-empty string because its tag site already validated it against the registry;
 * the residual `agent_error` family carries the innermost error's own name as its
 * detail, so it accepts any bare identifier that passes {@link isSafeErrorIdentifier}
 * (not a fixed word list) and drops anything else; a no-detail family always yields
 * undefined.
 *
 * @param errorClass - The failure family the detail belongs to.
 * @param detail - The observed detail, or undefined when none was resolved.
 * @returns The detail if it is legal for the family, otherwise undefined.
 */
export function normalizeErrorDetail(
  errorClass: TelemetryErrorClass,
  detail: string | undefined,
): string | undefined {
  if (detail === undefined || detail === "") {
    return undefined;
  }

  // The residual bucket's detail is the innermost error's name, an open value gated
  // by the identifier allowlist rather than a fixed word list.
  if (errorClass === "agent_error") {
    return isSafeErrorIdentifier(detail) ? detail : undefined;
  }

  if (OPEN_DETAIL_CLASSES.has(errorClass)) {
    return detail;
  }

  const allowed =
    FIXED_ERROR_DETAILS[errorClass as keyof typeof FIXED_ERROR_DETAILS];
  return allowed.includes(detail) ? detail : undefined;
}

/**
 * Derives who owns the fix for a failure from its class, detail, and stage. The
 * single source of owner truth; no other site should branch on (class, detail) to
 * decide an owner. Encodes the three cross-owner exceptions where a family sits
 * under one owner but a couple of its details are really someone else's problem:
 *
 * - `provider_error` is the provider's, except `auth`/`quota_exceeded` (the user's
 *   key or account) which are `environment`.
 * - `network_error` is the provider path's, except `dns`/`refused` (the user's
 *   machine or network) which are `environment`.
 * - `filesystem_error` is the user's, except at `finalize` (our own wiki write
 *   path) which is `openwiki`.
 *
 * @param errorClass - The failure family.
 * @param detail - The normalized detail, or undefined.
 * @param stage - The pipeline stage the failure was tagged at, or undefined.
 * @returns The owner responsible for acting on the failure.
 */
export function deriveOwner(
  errorClass: TelemetryErrorClass,
  detail: string | undefined,
  stage: TelemetryErrorStage | undefined,
): TelemetryErrorOwner {
  switch (errorClass) {
    case "config_error":
      return "environment";
    case "filesystem_error":
      return stage === "finalize" ? "openwiki" : "environment";
    case "provider_error":
      return detail !== undefined && PROVIDER_ENVIRONMENT_DETAILS.has(detail)
        ? "environment"
        : "provider";
    case "network_error":
      return detail !== undefined && NETWORK_ENVIRONMENT_DETAILS.has(detail)
        ? "environment"
        : "provider";
    case "context_limit_error":
    case "build_error":
    case "connector_error":
    case "okf_error":
    case "checkpointer_error":
    case "tool_error":
    case "output_error":
      return "openwiki";
    case "agent_error":
      return "unowned";
    case "aborted":
      return "control";
  }
}
