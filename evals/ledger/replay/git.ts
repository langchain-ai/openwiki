import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { GitReplayError } from "../core/errors.js";

/**
 * Promise-returning `execFile` used to run Git without a shell.
 */
const execFileAsync = promisify(execFile);

/**
 * Git commit SHAs LEDGER will pass to Git: 7 to 40 lowercase hex characters. The
 * single source of truth for the SHA allowlist, reused wherever a commit id
 * crosses from untrusted benchmark JSON toward Git.
 */
export const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;

/**
 * Reject any string that is not a well-formed commit SHA before it reaches Git.
 * Commit ids originate in the benchmark JSON, so this closes the door on a
 * malformed benchmark smuggling an argument or option into a Git invocation.
 *
 * @param sha - The candidate commit id.
 *
 * @throws GitReplayError when the id is not 7 to 40 lowercase hex characters.
 */
export function assertValidCommitSha(sha: string): void {
  if (typeof sha !== "string" || !COMMIT_PATTERN.test(sha)) {
    throw new GitReplayError(
      `Refusing to use an invalid commit SHA: ${JSON.stringify(sha)}`,
    );
  }
}

/**
 * Run a Git command and return its trimmed stdout. Uses `execFile` with an
 * explicit argument array and `shell: false`, so arguments are never subject to
 * shell interpretation. Any non-zero exit becomes a `GitReplayError` carrying
 * stderr, because in a replay a failed Git command means the run cannot be
 * trusted to continue.
 *
 * @param cwd - Absolute working directory for the command.
 * @param args - Git arguments, not including the `git` program itself.
 *
 * @returns The command's trimmed stdout.
 *
 * @throws GitReplayError on a non-zero exit or spawn failure.
 */
export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["--no-pager", ...args], {
      cwd,
      maxBuffer: 1024 * 1024,
      shell: false,
    });

    return stdout.trim();
  } catch (error) {
    const stderr =
      typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr.trim()
        : (error as Error).message;

    throw new GitReplayError(`git ${args.join(" ")} failed: ${stderr}`);
  }
}
