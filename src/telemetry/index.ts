export { buildRunEvent, recordRun } from "./senders.js";
export type { RunEventContext } from "./senders.js";
export { recordRunSafe } from "./record-run-safe.js";
export { firstRunNoticePending } from "./install-id.js";
export {
  FIRST_RUN_NOTICE_BODY,
  FIRST_RUN_NOTICE_OPT_OUT,
  FIRST_RUN_NOTICE_VERIFY,
} from "./config.js";
export { classifyError } from "./errors.js";
export { isCiEnvironment, isTelemetryDisabled } from "./gates.js";
export type {
  RunTelemetry,
  TelemetryErrorClass,
  TelemetryMode,
} from "./types.js";
