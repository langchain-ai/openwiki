import {
  deriveOwner,
  isSafeErrorIdentifier,
  normalizeErrorDetail,
} from "./taxonomy.js";
import type {
  TelemetryErrorClass,
  TelemetryErrorOwner,
  TelemetryErrorStage,
} from "./types.js";

/**
 * A failure family paired with its detail, the two-level result of classifying a
 * raw error. `errorDetail` is the specific failure within the family, or undefined
 * when the family has no detail split or none could be read from the raw error.
 */
export interface ErrorClassification {
  /**
   * The closed-set failure family.
   */
  errorClass: TelemetryErrorClass;

  /**
   * The specific failure within the family, or undefined.
   *
   * @default undefined - the family has no detail split, or none was resolvable
   * from the raw error alone.
   */
  errorDetail?: string;
}

/**
 * Provider-native error codes we recognize, mapped to a class and detail. Read
 * internally only to disambiguate otherwise-identical statuses (a context-limit 400
 * vs any other 400); the code string itself is never emitted. Anything not on this
 * list is ignored, so the envelope stays closed.
 */
const PROVIDER_ERROR_CODES: Readonly<Record<string, ErrorClassification>> = {
  context_length_exceeded: { errorClass: "context_limit_error" },
  string_above_max_length: { errorClass: "context_limit_error" },
  rate_limit_exceeded: {
    errorClass: "provider_error",
    errorDetail: "rate_limit",
  },
  insufficient_quota: {
    errorClass: "provider_error",
    errorDetail: "quota_exceeded",
  },
  billing_hard_limit_reached: {
    errorClass: "provider_error",
    errorDetail: "quota_exceeded",
  },
  invalid_api_key: { errorClass: "provider_error", errorDetail: "auth" },
  authentication_error: { errorClass: "provider_error", errorDetail: "auth" },
  permission_error: { errorClass: "provider_error", errorDetail: "auth" },
  overloaded_error: { errorClass: "provider_error", errorDetail: "overloaded" },
  content_policy_violation: {
    errorClass: "provider_error",
    errorDetail: "content_filter",
  },
  content_filter: {
    errorClass: "provider_error",
    errorDetail: "content_filter",
  },
};

/**
 * Max links followed when unwrapping a nested error. Bounds the walk so a long or
 * cyclic `cause` chain cannot turn classification into a denial of service. Set well
 * above real nesting depth so a provider error buried under several framework
 * envelopes (agent -> middleware -> retry wrapper -> SDK error) still reaches its root
 * cause; the cycle-safe BFS makes a high bound cheap on well-formed chains.
 */
const MAX_UNWRAP_DEPTH = 32;

/**
 * Flattens a possibly-wrapped error into the chain of links to inspect, nearest
 * first: the error itself, then its `cause`, its single nested `error`, and any
 * `AggregateError.errors`. Read-only and cycle-safe: it only reads own properties,
 * never assigns, tracks visited objects, and stops at {@link MAX_UNWRAP_DEPTH}. The
 * original value is always the first link even when it is not an object (a thrown
 * string still gets classified), so callers see identical behavior for unwrapped
 * errors.
 *
 * @param error - The thrown value to flatten.
 * @returns The nearest-first list of links, at most {@link MAX_UNWRAP_DEPTH} long.
 */
export function unwrapErrorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const visited = new Set<object>();
  const queue: unknown[] = [error];

  while (queue.length > 0 && chain.length < MAX_UNWRAP_DEPTH) {
    const current = queue.shift();
    chain.push(current);

    if (
      typeof current !== "object" ||
      current === null ||
      visited.has(current)
    ) {
      continue;
    }
    visited.add(current);

    const node = current as {
      cause?: unknown;
      error?: unknown;
      errors?: unknown;
    };

    if (node.cause !== undefined) {
      queue.push(node.cause);
    }
    if (node.error !== undefined) {
      queue.push(node.error);
    }
    if (Array.isArray(node.errors)) {
      for (const nested of node.errors) {
        queue.push(nested);
      }
    }
  }

  return chain;
}

/**
 * Maps a possibly-wrapped error to a closed {@link ErrorClassification}. Walks the
 * unwrap chain nearest-first and returns the first link that yields a named class,
 * so a provider error hidden inside a tool-error wrapper or an `AggregateError` is
 * recovered instead of collapsing into the residual. Returns `agent_error` only when
 * no link in the chain carries a recognizable signal. Never leaks the message: links
 * are read to test regexes in-process, but only an enum member is ever returned.
 */
export function classifyError(error: unknown): ErrorClassification {
  for (const link of unwrapErrorChain(error)) {
    const result = classifyErrorLink(link);

    if (result.errorClass !== "agent_error") {
      return result;
    }
  }

  return { errorClass: "agent_error" };
}

/**
 * Classifies a single error link from the raw signal alone (status, provider code,
 * message, filesystem code). Priority runs most-specific to least: abort, recognized
 * provider code, HTTP status, tool shape, message regexes, filesystem code, then the
 * single `agent_error` catch-all.
 *
 * This reads only the raw signal of the one link it is given; the owned families
 * whose class comes from where the error was thrown (`build_error`, `connector_error`,
 * `okf_error`, `checkpointer_error`, plus tagged `config_error`/`tool_error` details)
 * are resolved from the origin tag by {@link describeErrorForTelemetry}, which prefers
 * the tag over this.
 */
function classifyErrorLink(error: unknown): ErrorClassification {
  if (error instanceof Error && error.name === "AbortError") {
    return { errorClass: "aborted" };
  }

  const providerCode = extractProviderErrorCode(error);
  if (providerCode && providerCode in PROVIDER_ERROR_CODES) {
    return PROVIDER_ERROR_CODES[providerCode];
  }

  const status = extractStatus(error);
  if (status === 401 || status === 403) {
    return { errorClass: "provider_error", errorDetail: "auth" };
  }
  if (status === 429) {
    return { errorClass: "provider_error", errorDetail: "rate_limit" };
  }
  if (status === 529 || status === 503) {
    return { errorClass: "provider_error", errorDetail: "overloaded" };
  }
  if (status !== undefined && status >= 500 && status < 600) {
    return { errorClass: "provider_error", errorDetail: "server_error" };
  }

  if (error instanceof Error && /tool/iu.test(error.name)) {
    // The tool name is a raw string; the emitted tool-name detail rides the origin
    // tag (validated against the tool registry), not this raw-error path.
    return { errorClass: "tool_error" };
  }

  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/is required to run openwiki/u.test(message)) {
    return {
      errorClass: "config_error",
      errorDetail: /base url/u.test(message)
        ? "missing_base_url"
        : "missing_credentials",
    };
  }
  if (/invalid model id/u.test(message)) {
    return { errorClass: "config_error", errorDetail: "invalid_model" };
  }
  if (
    /context length|maximum context|too many tokens|context window/u.test(
      message,
    )
  ) {
    return { errorClass: "context_limit_error" };
  }
  if (/quota|insufficient_quota|billing/u.test(message)) {
    return { errorClass: "provider_error", errorDetail: "quota_exceeded" };
  }
  if (/timeout|timed out|etimedout/u.test(message)) {
    return { errorClass: "provider_error", errorDetail: "timeout" };
  }
  if (/enotfound|eai_again/u.test(message)) {
    return { errorClass: "network_error", errorDetail: "dns" };
  }
  if (/econnrefused/u.test(message)) {
    return { errorClass: "network_error", errorDetail: "refused" };
  }
  if (/econnreset/u.test(message)) {
    return { errorClass: "network_error", errorDetail: "reset" };
  }
  if (/network|fetch failed/u.test(message)) {
    return { errorClass: "network_error", errorDetail: "unreachable" };
  }
  if (/content policy|content filter|content_filter|refus/u.test(message)) {
    return { errorClass: "provider_error", errorDetail: "content_filter" };
  }
  if (/could not parse|invalid json/u.test(message)) {
    return { errorClass: "output_error", errorDetail: "json_parse" };
  }
  if (/schema/u.test(message)) {
    return { errorClass: "output_error", errorDetail: "schema" };
  }

  const code =
    error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  if (code === "ENOENT") {
    return { errorClass: "filesystem_error", errorDetail: "not_found" };
  }
  if (code === "EACCES" || code === "EPERM") {
    return { errorClass: "filesystem_error", errorDetail: "permission" };
  }
  if (code === "ENOSPC") {
    return { errorClass: "filesystem_error", errorDetail: "no_space" };
  }

  return { errorClass: "agent_error" };
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
 * The provider status read from the nearest link in the unwrap chain that exposes
 * one, or undefined. Lets a wrapped provider error still emit its numeric status even
 * when the top-level wrapper carries none.
 */
export function firstStatusInChain(error: unknown): number | undefined {
  for (const link of unwrapErrorChain(error)) {
    const status = extractStatus(link);

    if (status !== undefined) {
      return status;
    }
  }

  return undefined;
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
 * The origin tag stamped onto an error as it unwinds: always the pipeline `stage`,
 * and for owned families the `errorClass` and `errorDetail` decided at the throw
 * site (where the class is known from context, not from a message string). Carried
 * on a non-enumerable symbol so it never serializes into a telemetry payload or a
 * JSON dump.
 */
interface ErrorOriginTag {
  /**
   * The pipeline stage the failure occurred in.
   */
  stage: TelemetryErrorStage;

  /**
   * The failure family, when the throw site owns the classification. Absent for a
   * plain stage bracket, which leaves the class to the raw-error classifier.
   *
   * @default undefined - stage-only tag; the class comes from `classifyError`.
   */
  errorClass?: TelemetryErrorClass;

  /**
   * The detail decided at the throw site, paired with `errorClass`.
   *
   * @default undefined - no origin-supplied detail.
   */
  errorDetail?: string;
}

/**
 * The class an owned-family throw site declares about itself, passed to
 * {@link inStage} / {@link inStageSync} so the tag carries class and detail, not
 * just stage.
 */
export interface ErrorOrigin {
  /**
   * The failure family this throw site produces.
   */
  errorClass: TelemetryErrorClass;

  /**
   * The specific detail within the family (e.g. the pass name, or a registry id).
   *
   * @default undefined - the family has no detail split.
   */
  errorDetail?: string;
}

/**
 * Non-enumerable symbol carrying the {@link ErrorOriginTag}. Non-enumerable so it
 * never serializes into a telemetry payload or a JSON dump.
 */
const ERROR_ORIGIN = Symbol.for("openwiki.telemetry.errorOrigin");

/**
 * Stamps an origin tag onto `error` if it does not already carry one (first tag
 * wins, so the innermost/earliest origin is preserved as the error unwinds). No-op
 * for non-objects.
 *
 * @param error - The thrown value to tag.
 * @param tag - The stage, and optionally the owned-family class and detail.
 */
function tagErrorOrigin(error: unknown, tag: ErrorOriginTag): void {
  if (typeof error !== "object" || error === null) {
    return;
  }

  const target = error as Record<symbol, unknown>;
  if (target[ERROR_ORIGIN] !== undefined) {
    return;
  }

  Object.defineProperty(error, ERROR_ORIGIN, {
    value: tag,
    enumerable: false,
    configurable: true,
    writable: false,
  });
}

/**
 * Reads the origin tag stamped directly on a single error object, or undefined if
 * this object was never tagged. Reads only this one object; {@link readErrorOrigin}
 * is what walks the unwrap chain over it.
 */
function readOwnOriginTag(error: unknown): ErrorOriginTag | undefined {
  if (typeof error === "object" && error !== null) {
    const tag = (error as Record<symbol, unknown>)[ERROR_ORIGIN];
    if (typeof tag === "object" && tag !== null && "stage" in tag) {
      return tag as ErrorOriginTag;
    }
  }

  return undefined;
}

/**
 * The origin tag that governs classification, resolved across the whole unwrap
 * chain. Mirrors {@link classifyError}: it walks the chain nearest-first and returns
 * the first link whose tag names an owned family (its class, detail, and throw-site
 * stage), so an owned error re-wrapped by a framework keeps its class instead of
 * decaying into `agent_error`. LangChain's `MiddlewareError`, for one, copies the
 * inner message onto a fresh wrapper but strands the tag on `.cause`, so a top-only
 * read would lose the owned class. When no link owns a class, the nearest stage-only
 * tag is returned so a plain stage bracket still reports its stage.
 *
 * @param error - The thrown value whose chain to inspect.
 * @returns The governing origin tag, or undefined when no link was ever tagged.
 */
function readErrorOrigin(error: unknown): ErrorOriginTag | undefined {
  let nearestStageOnly: ErrorOriginTag | undefined;

  for (const link of unwrapErrorChain(error)) {
    const tag = readOwnOriginTag(link);
    if (tag === undefined) {
      continue;
    }

    // An owned-family tag wins outright: it carries the class and detail decided at
    // the throw site, along with that site's own stage.
    if (tag.errorClass !== undefined) {
      return tag;
    }

    // A stage-only tag is only a fallback; keep the nearest one in case no deeper
    // link owns a class.
    if (nearestStageOnly === undefined) {
      nearestStageOnly = tag;
    }
  }

  return nearestStageOnly;
}

/**
 * Stamps just the pipeline `stage` onto `error` (first tag wins). The one call a
 * plain stage bracket uses; the class is left to the raw-error classifier.
 */
export function tagErrorStage(
  error: unknown,
  stage: TelemetryErrorStage,
): void {
  tagErrorOrigin(error, { stage });
}

/**
 * Runs `fn`, tagging any thrown error with `stage` (and, when `origin` is given,
 * the owned-family class and detail) before it propagates. The one call the run
 * pipeline uses to bracket a stage. Pass `origin` at an owned-family throw site so
 * the failure carries its class and detail from where it was thrown, not from a
 * message string.
 *
 * @param stage - The pipeline stage to tag on a throw.
 * @param fn - The work to run.
 * @param origin - The owned-family class and detail, when the throw site owns the
 *   classification.
 */
export async function inStage<T>(
  stage: TelemetryErrorStage,
  fn: () => Promise<T>,
  origin?: ErrorOrigin,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    tagErrorOrigin(error, { stage, ...origin });
    throw error;
  }
}

/**
 * Synchronous {@link inStage}, for the synchronous build steps (`createModel`,
 * `createDeepAgent`) that can throw before any promise is created.
 */
export function inStageSync<T>(
  stage: TelemetryErrorStage,
  fn: () => T,
  origin?: ErrorOrigin,
): T {
  try {
    return fn();
  } catch (error) {
    tagErrorOrigin(error, { stage, ...origin });
    throw error;
  }
}

/**
 * The full telemetry description of a failure, ready to spread into the run facts.
 */
export interface ErrorTelemetry {
  /**
   * The closed-set failure family.
   */
  errorClass: TelemetryErrorClass;

  /**
   * The specific failure within the family, normalized against its allowlist, or
   * undefined.
   */
  errorDetail: string | undefined;

  /**
   * The pipeline stage the failure was tagged at, or undefined when uninstrumented.
   */
  errorStage: TelemetryErrorStage | undefined;

  /**
   * Who owns the fix, derived from (class, detail, stage).
   */
  errorOwner: TelemetryErrorOwner;

  /**
   * The provider's numeric status, or undefined. A bare integer.
   */
  httpStatus: number | undefined;
}

/**
 * The constructor name of `value`, but only if it is a bare identifier; otherwise
 * undefined. Reads the name through the prototype (not an own `constructor` property)
 * so a tampered own `constructor` cannot smuggle a value past the allowlist.
 * Non-objects have no constructor name and yield undefined. Gated by the shared
 * {@link isSafeErrorIdentifier}.
 *
 * @param value - The value to fingerprint.
 * @returns The allowlisted constructor name, or undefined.
 */
export function safeConstructorName(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const proto = Object.getPrototypeOf(value) as {
    constructor?: { name?: unknown };
  } | null;
  const raw = proto?.constructor?.name;

  return isSafeErrorIdentifier(raw) ? raw : undefined;
}

/**
 * The `.name` property of `value`, but only if it is a bare identifier; otherwise
 * undefined. This is the identity a framework deliberately sets: LangChain's
 * `MiddlewareError.wrap` copies the inner error's `.name` up onto the wrapper, so
 * reading `.name` recovers the real failure's identity even when `constructor.name`
 * reports the envelope class. Gated by the shared {@link isSafeErrorIdentifier}.
 *
 * @param value - The value to fingerprint.
 * @returns The allowlisted `.name`, or undefined.
 */
export function safeErrorName(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const raw = (value as { name?: unknown }).name;
  return isSafeErrorIdentifier(raw) ? raw : undefined;
}

/**
/**
 * The most specific allowlisted identifier for a single chain link, or undefined.
 * Reconciles the two identity sources: a link's own `.name`, which a framework like
 * LangChain's `MiddlewareError` deliberately sets to the inner error's name, and its
 * `constructor.name`. The `.name` wins because it is the identity a wrapper copies up
 * (e.g. `AI_APICallError` on a `MiddlewareError`), except when it is the bare base
 * `"Error"`: an `Error` subclass that never sets `this.name` inherits `"Error"`, which
 * says less than the constructor (e.g. a `ProviderCrash` subclass), so there the
 * constructor is preferred. Both candidates pass the same allowlist.
 *
 * @param link - One error in the unwrap chain.
 * @returns The link's most specific allowlisted identifier, or undefined.
 */
function linkErrorName(link: unknown): string | undefined {
  const name = safeErrorName(link);
  const constructorName = safeConstructorName(link);

  if (name !== undefined && name !== "Error") {
    return name;
  }
  return constructorName ?? name;
}

/**
 * The allowlisted identifier of the innermost error in the unwrap chain, or
 * undefined. This is the one signal the residual `agent_error` bucket carries, so it
 * must name the real failure and not a wrapper: a framework envelope copies the inner
 * message but reports its own constructor, so fingerprinting the outermost link
 * collapses every distinct root cause to the wrapper's name. Each link is resolved by
 * {@link linkErrorName} (its deliberately-set `.name`, else its constructor), and the
 * deepest link that yields a name wins. Walking to the deepest link recovers the
 * actual failure's identity (e.g. the provider SDK's own error class) while the shared
 * {@link isSafeErrorIdentifier} allowlist keeps the anonymity envelope closed. Falls
 * back to the outermost allowlisted name when only the wrapper has one. The walk
 * reuses the read-only, cycle-safe {@link unwrapErrorChain}.
 *
 * @param error - The thrown value to fingerprint.
 * @returns The innermost allowlisted identifier, or undefined.
 */
export function innermostErrorName(error: unknown): string | undefined {
  let deepest: string | undefined;

  for (const link of unwrapErrorChain(error)) {
    const name = linkErrorName(link);
    if (name !== undefined) {
      deepest = name;
    }
  }

  return deepest;
}

/**
 * The single call the failure path uses: class, detail, owner, stage, and status in
 * one object, ready to spread into the run facts. The class and detail come from the
 * origin tag when the throw site owned the classification (build/connector/okf/
 * checkpointer, or a tagged config/tool detail), otherwise from {@link classifyError}
 * walking the unwrap chain. The one exception is the `build_error/stream_open` tag:
 * that stage is the first provider round trip, so a failure there carrying a provider
 * signal is a disguised provider error and the raw classification wins over the tag
 * (see {@link streamOpenDisguisesProvider}). For the residual `agent_error` bucket the
 * detail is instead the innermost error's own name, the one signal that bucket
 * carries, read from the cause chain so a framework envelope like LangChain's
 * `MiddlewareError` does not collapse every root cause to the wrapper's name. The
 * detail is normalized against its family's allowlist (or the identifier allowlist for
 * `agent_error`), so an off-list value is dropped rather than emitted. Never leaks the
 * message.
 */
export function describeErrorForTelemetry(error: unknown): ErrorTelemetry {
  const origin = readErrorOrigin(error);
  const classified = classifyError(error);
  const httpStatus = firstStatusInChain(error);

  // An origin tag that names a class owns both class and detail; a stage-only tag
  // leaves both to the raw-error classifier. The lone override is a stream-open tag
  // over a disguised provider failure, which defers to the raw classifier so the
  // failure lands on the provider instead of being counted as our build bug.
  let errorClass: TelemetryErrorClass;
  let rawDetail: string | undefined;
  if (
    origin?.errorClass !== undefined &&
    !streamOpenDisguisesProvider(origin, classified, httpStatus)
  ) {
    errorClass = origin.errorClass;
    rawDetail = origin.errorDetail;
  } else {
    errorClass = classified.errorClass;
    rawDetail = classified.errorDetail;
  }

  // The residual bucket carries no origin/classified detail; its one signal is the
  // innermost error's own name. Every named class keeps its taxonomy detail.
  const detailInput =
    errorClass === "agent_error" ? innermostErrorName(error) : rawDetail;

  const errorDetail = normalizeErrorDetail(errorClass, detailInput);
  const errorStage = origin?.stage;

  return {
    errorClass,
    errorDetail,
    errorStage,
    errorOwner: deriveOwner(errorClass, errorDetail, errorStage),
    // Surfaced from the chain so a wrapped provider error still emits its status
    // even when an origin tag already named the class.
    httpStatus,
  };
}

/**
 * Whether a `build_error/stream_open` origin tag is really masking a provider
 * failure. The stream-open call is the only build stage that crosses into provider
 * territory (the first token/HTTP round trip), so a throw there that carries a
 * provider signal — the raw classifier already naming it `provider_error`, or an HTTP
 * status on the chain paired with any named (non-residual) classification — is the
 * provider's fault, not ours, and the raw classification should win over the tag.
 * Guarded to a named class so a genuine stream-setup failure with no provider signal
 * (which classifies as the residual `agent_error`) keeps its informative
 * `build_error/stream_open` tag instead of regressing to the residual bucket.
 *
 * @param origin - The origin tag read off the error, if any.
 * @param classified - The raw-error classification of the same error.
 * @param httpStatus - The first HTTP status found on the chain, or undefined.
 * @returns True when the raw classification should override the tag.
 */
function streamOpenDisguisesProvider(
  origin: ErrorOriginTag | undefined,
  classified: ErrorClassification,
  httpStatus: number | undefined,
): boolean {
  if (
    origin?.errorClass !== "build_error" ||
    origin.errorDetail !== "stream_open"
  ) {
    return false;
  }

  return (
    classified.errorClass === "provider_error" ||
    (httpStatus !== undefined && classified.errorClass !== "agent_error")
  );
}
