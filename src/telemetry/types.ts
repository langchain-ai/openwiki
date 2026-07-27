/**
 * Closed set of failure categories. Raw error strings are never sent; only these
 * enum values leave the process. `provider_*` marks an error the model provider's
 * API returned; bare names are our-side or environment failures. `agent_error` is
 * the single catch-all for any failure that matched no rule (including a thrown
 * non-`Error`).
 */
export type TelemetryErrorClass =
  | "missing_credentials"
  | "missing_config"
  | "invalid_model"
  | "provider_auth"
  | "provider_rate_limit"
  | "provider_timeout"
  | "provider_overloaded"
  | "provider_server_error"
  | "provider_context_limit"
  | "provider_quota_exceeded"
  | "provider_content_filter"
  | "network"
  | "output_invalid"
  | "agent_error"
  | "tool_error"
  | "filesystem"
  | "aborted";

/**
 * Ordered pipeline stage a failure was tagged at: config -> build -> run ->
 * finalize. Lets a failure be read as "where in the run did it break", so a class
 * can be located to a phase. An untagged failure carries no stage (the field is
 * omitted), which reads as "not instrumented here" rather than a named bucket.
 */
export type TelemetryErrorStage = "config" | "build" | "run" | "finalize";

/**
 * Which brain a run targeted.
 */
export type TelemetryMode = "code" | "personal";

/**
 * Everything the run event reports, assembled by the agent run lifecycle.
 *
 * Two tiers: `command`, `outcome`, and `errorClass` ride on every run
 * (activity + reliability); `mode`, `provider`, and `configuredConnectors` are
 * setup choices, captured on **init only** (the configuration moment), so the
 * agent leaves them undefined on updates. The `ci` split and identity are added
 * by `send`, not here.
 */
export interface RunTelemetry {
  /**
   * Which run lifecycle produced this event. Chat is deliberately excluded (it
   * is interactive and would emit one event per turn), so only init and update
   * ever produce an openwiki_run event.
   */
  command: "init" | "update";

  /**
   * How the run ended. `noop` is an update that short-circuited unchanged.
   */
  outcome: "success" | "failure" | "noop";

  /**
   * Closed-set failure category. Present only when `outcome` is "failure".
   */
  errorClass?: TelemetryErrorClass;

  /**
   * Pipeline stage the failure was tagged at. Present only when `outcome` is
   * "failure", and only when the throwing path was instrumented.
   *
   * @default undefined - the error carried no stage tag; the throw site is not
   * instrumented, so no stage is emitted.
   */
  errorStage?: TelemetryErrorStage;

  /**
   * HTTP-ish status read off the provider error, when one was present. A bare
   * integer; no provider strings ride with it. Present only on failure.
   *
   * @default undefined - the error exposed no numeric status.
   */
  httpStatus?: number;

  /**
   * Which brain was set up (code = repository, personal = local wiki). Init
   * only; undefined on updates.
   */
  mode?: TelemetryMode;

  /**
   * LLM provider chosen at setup (e.g. "anthropic", "openai"). Init only;
   * undefined on updates.
   */
  provider?: string;

  /**
   * Ids of auth-gated connectors configured at setup. Each becomes a boolean
   * `connector_<id>` property (present = configured), so connector adoption is a
   * point-and-click dimension with no array unnesting. Init only.
   */
  configuredConnectors?: string[];

  /**
   * Optional tee target from --telemetry-file.
   */
  telemetryFile?: string;
}

/**
 * Internal: the fully-assembled event handed to the client and the tee.
 */
export interface TelemetryEvent {
  /**
   * Identity the event is attributed to: install id, or the CI sentinel.
   */
  distinctId: string;

  /**
   * PostHog event name (one of the TELEMETRY_*_EVENT constants).
   */
  event: string;

  /**
   * The property bag sent to PostHog.
   */
  properties: Record<string, unknown>;
}
