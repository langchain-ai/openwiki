import path from "node:path";

/**
 * Path-based write guard for the claude-cli provider.
 *
 * The `claude` CLI backend bypasses DeepAgents entirely (see docs-only-backend.ts),
 * so the docs-only restriction has to be re-enforced out of band via a PreToolUse
 * hook instead of a LocalShellBackend subclass. This module holds the pure
 * decision logic so it can be unit tested without spawning a real hook process.
 */
export interface WriteGuardDecision {
  allowed: boolean;
  reason?: string;
}

export interface EvaluateWritePathOptions {
  /** Absolute path to the repository root the claude-cli agent was launched against. */
  repoRoot: string;
  /** Path, relative to repoRoot, that writes/edits must stay within (e.g. "openwiki"). */
  allowedRelativeDir: string;
  /** The file_path the tool call wants to write/edit, as reported by Claude Code. */
  filePath: string;
  /** cwd reported by the hook payload, used to resolve relative filePath values. */
  cwd?: string;
}

export function evaluateWritePath(
  options: EvaluateWritePathOptions,
): WriteGuardDecision {
  const { repoRoot, allowedRelativeDir, filePath, cwd } = options;

  if (!filePath || filePath.trim() === "") {
    return { allowed: false, reason: "Refused: empty file path." };
  }

  const resolvedRepoRoot = path.resolve(repoRoot);
  const allowedDir = path.resolve(resolvedRepoRoot, allowedRelativeDir);
  const resolvedFilePath = path.resolve(cwd ?? resolvedRepoRoot, filePath);

  if (!isWithinDir(resolvedRepoRoot, resolvedFilePath)) {
    return {
      allowed: false,
      reason: `Refused path: ${filePath} is outside the repository (${resolvedRepoRoot}).`,
    };
  }

  if (!isWithinDir(allowedDir, resolvedFilePath)) {
    return {
      allowed: false,
      reason: `claude-cli init/update runs may only write under ${allowedRelativeDir}/. Refused path: ${filePath}`,
    };
  }

  return { allowed: true };
}

function isWithinDir(dir: string, target: string): boolean {
  return target === dir || target.startsWith(`${dir}${path.sep}`);
}
