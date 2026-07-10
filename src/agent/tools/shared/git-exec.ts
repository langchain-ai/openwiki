import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_BYTES = 100_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export type GitCommandResult = {
  output: string;
  error?: string;
};

export type RunGitCommandOptions = {
  timeoutMs?: number;
};

/**
 * Runs a read-only git command with `execFile` (never a shell). `--no-pager` is
 * always injected as the first argument. Command errors (including non-git
 * directories and timeouts) are captured and returned rather than thrown, so
 * callers can surface them to the agent as tool output.
 */
export async function runGitCommand(
  cwd: string,
  args: string[],
  options: RunGitCommandOptions = {},
): Promise<GitCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["--no-pager", ...args],
      {
        cwd,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        env: buildGitEnv(),
        windowsHide: true,
      },
    );

    return { output: truncateOutput(combineStreams(stdout, stderr)) };
  } catch (error) {
    if (isExecError(error)) {
      const combined = truncateOutput(
        combineStreams(error.stdout, error.stderr),
      );

      if (error.killed) {
        return {
          output: combined,
          error: "git command timed out",
        };
      }

      return {
        output: combined,
        error: error.stderr?.trim() || error.message,
      };
    }

    throw error;
  }
}

/**
 * Builds a minimal environment for git so system/global config and interactive
 * prompts cannot influence or block automated runs.
 */
function buildGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };

  // git.exe on Windows needs SystemRoot to initialize its socket/crypto stack.
  if (process.platform === "win32" && process.env.SystemRoot) {
    env.SystemRoot = process.env.SystemRoot;
  }

  return env;
}

function combineStreams(stdout?: string, stderr?: string): string {
  return [stdout?.trim(), stderr?.trim()].filter(Boolean).join("\n").trim();
}

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_BYTES) {
    return output;
  }

  return `${output.slice(0, MAX_OUTPUT_BYTES)}\n[output truncated]`;
}

function isExecError(
  error: unknown,
): error is Error & { stdout?: string; stderr?: string; killed?: boolean } {
  return error instanceof Error && ("stdout" in error || "stderr" in error);
}
