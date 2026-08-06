/**
 * Closed set of failure families, the big bucket a failure falls in. Raw error
 * strings are never sent; only these enum values leave the process. Each family
 * pairs with an `errorDetail` (the specific failure inside it) and derives an
 * `errorOwner` (whose problem it is). `agent_error` is the residual for any
 * failure that matched no rule (including a thrown non-`Error`); it is the quality
 * meter and should trend toward zero.
 *
 * The full taxonomy (families, per-family detail allowlists, and owner rules) lives
 * in `taxonomy.ts`.
 */
export type TelemetryErrorClass =
  | "config_error"
  | "filesystem_error"
  | "provider_error"
  | "network_error"
  | "context_limit_error"
  | "build_error"
  | "connector_error"
  | "okf_error"
  | "checkpointer_error"
  | "tool_error"
  | "output_error"
  | "agent_error"
  | "aborted";

/**
 * Who owns the fix for a failure, derived from its class, detail, and stage (see
 * `deriveOwner` in `taxonomy.ts`). This is emitted so the health dashboard can roll
 * failures up by who has to act, including the cross-owner exceptions (a
 * `provider_error` with detail `auth` is really the user's key, so it owns to
 * `environment`) that PostHog cannot derive on its own.
 *
 * - `environment`: the user's setup, credentials, or machine.
 * - `provider`: the provider API failed transiently; retry/backoff.
 * - `openwiki`: we own the fix, whether a bug or work like chunking.
 * - `unowned`: the agent/model core failed in a way we have not named yet.
 * - `control`: the run was cancelled; excluded from failure-rate math.
 */
export type TelemetryErrorOwner =
  "environment" | "provider" | "openwiki" | "unowned" | "control";

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
 * The distribution channel a build was produced for, baked in at build time and
 * stamped on every event so fork-originated telemetry can be filtered out from
 * the official-release signal on the dashboard.
 *
 * - `official`: an npm-published upstream build (the release pipeline bakes this).
 * - `community`: anything else — a fork, a local build, or a source/dev run.
 */
export type BuildChannel = "official" | "community";

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
   * Closed-set failure family. Present only when `outcome` is "failure".
   */
  errorClass?: TelemetryErrorClass;

  /**
   * The specific failure within `errorClass`, from that family's hardcoded
   * allowlist (see `taxonomy.ts`), e.g. `auth` inside `provider_error`. For the
   * residual `agent_error` family it is instead the innermost error's own name (a
   * bare identifier), the one signal that bucket carries, so it can be broken down
   * into a ranked list of unhandled error types. One shared property across all
   * families. Anything off the family's allowlist (or the identifier allowlist for
   * `agent_error`) is dropped to undefined rather than sent raw, so the anonymity
   * envelope stays closed.
   *
   * @default undefined - the family has no detail split, or the observed detail was
   * not on the family's allowlist; the field is omitted rather than sent raw.
   */
  errorDetail?: string;

  /**
   * Who owns the fix, derived from (class, detail, stage) at record time. Emitted
   * (not left for PostHog to derive) because the owner rules include cross-owner
   * exceptions PostHog cannot express. Present only when `outcome` is "failure".
   *
   * @default undefined - no failure to attribute (the run did not fail).
   */
  errorOwner?: TelemetryErrorOwner;

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
