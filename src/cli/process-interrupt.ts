/**
 * Minimal process surface used to deliver an interrupt after Ink has restored
 * the terminal. Kept injectable so the exit behavior can be tested safely.
 */
interface InterruptTarget {
  /** Emits SIGINT to any active recovery transaction. */
  emit(event: "SIGINT"): boolean;

  /** Exits immediately when no recovery transaction owns SIGINT. */
  exit(code: number): unknown;
}

/**
 * Restores the interactive UI first, then delivers SIGINT on the next turn.
 * Existing-wiki init installs a SIGINT handler that rolls the wiki back before
 * exiting. Other commands have no handler and exit immediately with code 130.
 */
export function requestProcessInterrupt(
  restoreTerminal: () => void,
  target: InterruptTarget = process,
): void {
  restoreTerminal();

  setImmediate(() => {
    if (!target.emit("SIGINT")) {
      target.exit(130);
    }
  });
}
