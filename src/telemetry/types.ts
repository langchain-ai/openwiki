/**
 * Closed set of failure categories. Raw error strings are never sent.
 */
export type TelemetryErrorClass =
  | "missing_credentials"
  | "missing_config"
  | "invalid_model"
  | "provider_auth"
  | "provider_rate_limit"
  | "provider_timeout"
  | "network"
  | "agent_error"
  | "tool_error"
  | "filesystem"
  | "aborted"
  | "unknown";

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
