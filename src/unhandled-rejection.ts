import { getErrorMessage } from "./diagnostics.js";

/**
 * Last-resort handler for promise rejections that escape every awaited chain —
 * for example a provider 429 raised inside an agent run that nothing is
 * awaiting, or a promise floated inside a dependency. Without a listener Node
 * aborts the process with a raw stack trace; this routes the failure through
 * the same user-facing path as awaited errors (`getErrorMessage`, which
 * redacts secrets and keeps the message actionable) and exits non-zero.
 *
 * Exported separately from the installer so tests can exercise the exact
 * function the process invokes.
 */
export function handleUnhandledRejection(reason: unknown): void {
  process.stderr.write(`${getErrorMessage(reason)}\n`);

  // An escaped rejection leaves the process in an unknown state, so keep
  // Node's crash semantics (its default is to abort) — just fail cleanly.
  // Setting `process.exitCode` is not enough here: unlike the awaited error
  // paths, there is no caller left to wind the process down.
  process.exit(1);
}

/**
 * Installs the top-level `unhandledRejection` net. The CLI entry calls this
 * before any async work starts so every command is covered.
 */
export function installUnhandledRejectionHandler(): void {
  process.on("unhandledRejection", handleUnhandledRejection);
}
