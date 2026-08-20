import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HostIntegrationError } from "./errors.js";

const GIT_TIMEOUT_MS = 10_000;

/**
 * Resolves an absolute path to its canonical Git worktree root.
 *
 * The lifecycle boundary deliberately refuses the filesystem root and the
 * current user's home directory. This prevents a globally installed host
 * integration from treating an ambiguous agent launch directory as a wiki
 * repository.
 *
 * @param candidate - Absolute directory supplied by the host skill.
 * @returns Canonical absolute Git worktree root.
 */
export async function resolveRepositoryRoot(
  candidate: string,
): Promise<string> {
  if (!path.isAbsolute(candidate)) {
    throw new HostIntegrationError(
      "invalid_input",
      "The OpenWiki root must be an absolute path inside a Git repository.",
    );
  }

  const directory = await resolveExistingDirectory(candidate);
  const gitRoot = await resolveGitTopLevel(directory);
  await assertSafeRepositoryRoot(gitRoot);
  return gitRoot;
}

/**
 * Canonicalizes an existing directory without exposing its path in errors.
 *
 * @param candidate - Absolute directory candidate.
 * @returns Canonical absolute directory.
 */
async function resolveExistingDirectory(candidate: string): Promise<string> {
  try {
    const directory = await realpath(candidate);
    if (!(await lstat(directory)).isDirectory()) {
      throw new HostIntegrationError(
        "invalid_input",
        "The OpenWiki root must be a directory.",
      );
    }
    return directory;
  } catch (error) {
    if (error instanceof HostIntegrationError) throw error;
    throw new HostIntegrationError(
      "invalid_input",
      "The OpenWiki root must be an existing directory.",
    );
  }
}

/**
 * Asks Git for the top-level worktree containing a directory.
 *
 * @param directory - Canonical directory inside the requested repository.
 * @returns Canonical Git worktree root.
 */
async function resolveGitTopLevel(directory: string): Promise<string> {
  try {
    const stdout = await executeGit(directory, [
      "rev-parse",
      "--show-toplevel",
    ]);
    const topLevel = stdout.trim();
    if (!topLevel || !path.isAbsolute(topLevel))
      throw new Error("invalid root");
    return await resolveExistingDirectory(topLevel);
  } catch (error) {
    if (error instanceof HostIntegrationError) throw error;
    throw new HostIntegrationError(
      "invalid_input",
      "The OpenWiki root must be inside a Git repository.",
    );
  }
}

/**
 * Executes one bounded, read-only Git query.
 *
 * @param directory - Working directory supplied to Git.
 * @param args - Ordered Git arguments.
 * @returns Standard output emitted by Git.
 */
function executeGit(
  directory: string,
  args: readonly string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", directory, ...args],
      { encoding: "utf8", timeout: GIT_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          reject(
            error instanceof Error
              ? error
              : new Error("The Git repository query failed."),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Rejects roots that are too broad for implicit host-driven documentation.
 *
 * @param repositoryRoot - Canonical Git worktree root.
 */
async function assertSafeRepositoryRoot(repositoryRoot: string): Promise<void> {
  const filesystemRoot = path.parse(repositoryRoot).root;
  const homeDirectory = await realpath(os.homedir()).catch(() =>
    path.resolve(os.homedir()),
  );
  if (repositoryRoot === filesystemRoot || repositoryRoot === homeDirectory) {
    throw new HostIntegrationError(
      "invalid_input",
      "OpenWiki refuses to use the filesystem root or home directory as a repository root.",
    );
  }
}
