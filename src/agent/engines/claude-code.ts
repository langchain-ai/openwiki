import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AgentCliAdapter,
  AgentCliInstallStatus,
  EngineRunSpec,
} from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Documentation-shaped tool allowlist: read/search anywhere in the repo,
 * write docs, read-only git, and the single exact rm needed to clean up the
 * temporary plan file. Network tools stay excluded on purpose.
 */
export const CLAUDE_CODE_ALLOWED_TOOLS = [
  "Task",
  "TodoWrite",
  "Read",
  "Glob",
  "Grep",
  "LS",
  "Write",
  "Edit",
  "MultiEdit",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git diff:*)",
  "Bash(git status:*)",
  "Bash(git blame:*)",
  "Bash(git rev-parse:*)",
  "Bash(rm -f openwiki/_plan.md)",
].join(",");

export const claudeCodeAdapter: AgentCliAdapter = {
  id: "claude-code",

  async detectInstall(binary: string): Promise<AgentCliInstallStatus> {
    try {
      const { stdout } = await execFileAsync(binary, ["--version"], {
        timeout: 15_000,
      });

      return { found: true, version: stdout.trim() };
    } catch {
      return { found: false };
    }
  },

  buildArgs(spec: EngineRunSpec): string[] {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--append-system-prompt",
      spec.systemPrompt,
      "--allowedTools",
      CLAUDE_CODE_ALLOWED_TOOLS,
    ];

    if (spec.modelId !== "default") {
      args.push("--model", spec.modelId);
    }

    if (spec.resumeSessionId) {
      args.push("--resume", spec.resumeSessionId);
    }

    return args;
  },

  parseEvent(): [] {
    return [];
  },
};
