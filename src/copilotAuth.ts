import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GH_CLI_TIMEOUT_MS = 5_000;

export async function isGhCliAvailable(): Promise<boolean> {
  try {
    await execFileAsync("gh", ["--version"], { timeout: GH_CLI_TIMEOUT_MS });

    return true;
  } catch {
    return false;
  }
}

// `gh auth token` prints the OAuth token for the current GitHub CLI
// session. It fails (non-zero exit) if `gh` is missing or unauthenticated.
export async function detectGhCliToken(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], {
      timeout: GH_CLI_TIMEOUT_MS,
    });
    const token = stdout.trim();

    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

// Runs the GitHub CLI's own interactive device-flow login, inheriting the
// current terminal so the user can follow its prompts directly. Callers
// must release Ink's raw-mode control of stdin first (see useStdin's
// setRawMode) so `gh`'s own prompts can read input correctly.
export function runGhAuthLogin(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("gh", ["auth", "login", "--hostname", "github.com"], {
      stdio: "inherit",
    });

    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}
