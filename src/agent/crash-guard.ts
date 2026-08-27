import { describeErrorForTelemetry } from "../telemetry/errors.js";
import { recordRunSafe } from "../telemetry/record-run-safe.js";

import type { OpenWikiCommand, OpenWikiOutputMode } from "./types.js";
import {
  persistRunMetadataIfChanged,
  type OpenWikiContentSnapshot,
} from "./utils.js";

/**
 * Everything the crash guard needs to record and stamp an interrupted run
 * post-mortem, captured when a run starts. A run registers this on entry so that a
 * rejection escaping every catch can still be attributed to the run that caused it.
 */
export interface ActiveRunRecord {
  /**
   * Command of the in-flight run. Only init/update reach telemetry; chat is dropped
   * downstream by `recordRunSafe`, but the stamp still runs for it.
   */
  command: OpenWikiCommand;

  /**
   * Repo (or local-wiki) root the run writes into.
   */
  cwd: string;

  /**
   * Resolved model id, written into the interrupted stamp.
   */
  modelId: string;

  /**
   * Output mode; decides where the stamp lives and the recorded run's brain mode.
   */
  outputMode: OpenWikiOutputMode;

  /**
   * Content snapshot taken before the run; the stamp writes only if content changed
   * since.
   *
   * @default undefined - no snapshot was captured before the run (e.g. chat), so the
   * interrupted stamp is skipped.
   */
  snapshotBefore?: OpenWikiContentSnapshot;

  /**
   * Effective wiki language, preserved in the stamp.
   *
   * @default undefined - the run has no explicit wiki language; the stamp omits it.
   */
  language?: string;
}

/**
 * The single in-flight run, or undefined when idle. OpenWiki executes one run per
 * process by design, so a module-level slot is sufficient and there is no registry
 * to key.
 */
let activeRun: ActiveRunRecord | undefined;

/**
 * Registers the run the process is currently executing, so a fatal signal can
 * attribute the crash. Call once a run's pre-flight snapshot exists.
 *
 * @param record - The in-flight run's post-mortem facts.
 */
export function registerActiveRun(record: ActiveRunRecord): void {
  activeRun = record;
}

/**
 * Clears the registration. Call in the run's `finally` so a clean run leaves no
 * stale record for a later crash to misattribute.
 */
export function clearActiveRun(): void {
  activeRun = undefined;
}

/**
 * The registered run, or undefined when the process is idle.
 */
export function getActiveRun(): ActiveRunRecord | undefined {
  return activeRun;
}

/**
 * Shared post-mortem for both fatal signals. Best-effort throughout: the crash may
 * have destroyed state the recorder or stamper wants, so each side effect is wrapped
 * and swallowed independently, and the process still exits non-zero regardless.
 * Telemetry is awaited only so its flush has a chance to complete before the exit;
 * a failure in it never blocks the stamp or the exit.
 *
 * A rejection that reaches here would otherwise kill the process with a raw stack, no
 * stamp, and no telemetry. Recording it means an escaped runtime rejection finally
 * appears in the data, classified and (when residual) fingerprinted by the same
 * boundary as every other failure; stamping it `interrupted` means the next
 * scheduled update retries instead of no-opping against a half-written wiki.
 *
 * @param source - Which handler fired (`unhandledRejection`/`uncaughtException`);
 *   used only for the local stderr line.
 * @param error - The escaped rejection or exception.
 */
export async function handleFatal(
  source: string,
  error: unknown,
): Promise<void> {
  // Claim the active run synchronously, before any await. The installer fires one
  // `void handleFatal(...)` per escaped rejection, and a burst of runtime rejections
  // lands on the microtask queue together; reading and clearing here with no await
  // between the two statements makes the claim atomic for the event loop, so the first
  // handler owns the crash and every later one sees `undefined` and only exits. Do not
  // move any await above this pair: doing so reintroduces the race where every
  // rejection records the same run and one crash produces hundreds of events.
  const active = getActiveRun();
  clearActiveRun();

  if (active) {
    // Record the crash as a failure so it finally appears in the data, classified
    // and fingerprinted by the same boundary as every other failure.
    try {
      await recordRunSafe(
        active.command,
        { outputMode: active.outputMode },
        { outcome: "failure", ...describeErrorForTelemetry(error) },
      );
    } catch {
      // Intentionally ignored: telemetry must never block the exit.
    }

    // Stamp interrupted so the next scheduled update does not no-op against a
    // half-written wiki.
    try {
      await persistRunMetadataIfChanged(
        active.command,
        active.cwd,
        active.modelId,
        active.outputMode,
        active.snapshotBefore ?? null,
        "interrupted",
        active.language,
      );
    } catch {
      // Intentionally ignored: the stamp is best-effort during a crash.
    }
  }

  // The local stderr line intentionally carries the raw message: it is the user's
  // own failure UX on their own terminal and never enters telemetry.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`OpenWiki run failed (${source}): ${message}\n`);

  if (error instanceof Error && error.stack && process.env.OPENWIKI_DEBUG) {
    process.stderr.write(`${error.stack}\n`);
  }

  // Give stderr a tick to flush, then exit non-zero. Without the explicit exit Node
  // would continue with undefined state after an uncaught exception.
  setImmediate(() => process.exit(1));
}

/**
 * Whether {@link installCrashGuard} has already registered its handlers. The guard
 * is a process-global singleton; installing twice would double-record and
 * double-exit, so repeat calls are no-ops.
 */
let installed = false;

/**
 * Installs the last-resort handlers for rejections and exceptions that bypass every
 * catch in the run. Idempotent, and meant to be called once at CLI startup, before
 * any run begins.
 */
export function installCrashGuard(): void {
  if (installed) {
    return;
  }
  installed = true;

  process.on("unhandledRejection", (reason) => {
    void handleFatal("unhandledRejection", reason);
  });
  process.on("uncaughtException", (error) => {
    void handleFatal("uncaughtException", error);
  });
}
