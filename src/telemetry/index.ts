export { buildRunEvent, recordRun } from "./senders.js";
export type { RunEventContext } from "./senders.js";
export { recordRunSafe } from "./record-run-safe.js";
export { withRunTelemetry } from "./with-run-telemetry.js";
export type { RunTelemetryContext } from "./with-run-telemetry.js";
export { firstRunNoticePending } from "./install-id.js";
export {
  FIRST_RUN_NOTICE_BODY,
  FIRST_RUN_NOTICE_OPT_OUT,
  FIRST_RUN_NOTICE_VERIFY,
} from "./config.js";
export {
  classifyError,
  describeErrorForTelemetry,
  inStage,
  inStageSync,
  tagErrorStage,
} from "./errors.js";
export type {
  ErrorClassification,
  ErrorOrigin,
  ErrorTelemetry,
} from "./errors.js";
export { deriveOwner, normalizeErrorDetail } from "./taxonomy.js";
export { isCiEnvironment, isTelemetryDisabled } from "./gates.js";
export type {
  RunTelemetry,
  TelemetryErrorClass,
  TelemetryErrorOwner,
  TelemetryErrorStage,
  TelemetryMode,
} from "./types.js";
