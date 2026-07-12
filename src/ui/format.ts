/**
 * Small display and environment helpers shared by the CLI's terminal UI.
 */

/**
 * Rewrites an absolute path to use `~` for the home directory, for display.
 * Returns the path unchanged when it is not under the home directory.
 */
export function formatCwd(cwd: string): string {
  const home = process.env.HOME;

  if (home && cwd.startsWith(home)) {
    return `~${cwd.slice(home.length)}`;
  }

  return cwd;
}

/**
 * True when debug output is enabled via `OPENWIKI_DEBUG=1`.
 */
export function isDebugMode(): boolean {
  return process.env.OPENWIKI_DEBUG === "1";
}

/**
 * True when a chat input is a request to quit the session (`/exit`, `exit`, or
 * `quit`, case- and whitespace-insensitive).
 */
export function isExitMessage(message: string): boolean {
  const normalizedMessage = message.trim().toLowerCase();

  return (
    normalizedMessage === "/exit" ||
    normalizedMessage === "exit" ||
    normalizedMessage === "quit"
  );
}
