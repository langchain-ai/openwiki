import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLAUDE_CLI_TIMEOUT_MS = 10_000;

/**
 * Sentinel recorded when a Claude Code CLI session is detected. The CLI holds
 * the actual credential and never exposes it, so there is nothing secret here —
 * this exists only so the provider fits the shared external-CLI setup flow.
 */
export const CLAUDE_CLI_SESSION_MARKER = "cli-session";

export const CLAUDE_CLI_UNAVAILABLE_MESSAGE =
  "The Claude Code CLI (`claude`) was not found on PATH. Install it from https://claude.com/claude-code, then run `claude` once to sign in.";

/**
 * Probes for the binary rather than for a valid login: verifying the session
 * would cost a full `claude -p` round trip on every setup screen, so an expired
 * login is left to surface as a clear error on the first generation call.
 */
export async function readClaudeCliSession(): Promise<string | null> {
  try {
    await execFileAsync("claude", ["--version"], {
      timeout: CLAUDE_CLI_TIMEOUT_MS,
    });

    return CLAUDE_CLI_SESSION_MARKER;
  } catch {
    return null;
  }
}
