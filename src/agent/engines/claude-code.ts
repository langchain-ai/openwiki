import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { formatToolArgs } from "../tool-format.js";
import type {
  AgentCliAdapter,
  AgentCliEvent,
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

  parseEvent(line: unknown): AgentCliEvent[] {
    if (!isRecord(line) || typeof line.type !== "string") {
      return [];
    }

    if (line.type === "system") {
      return parseSystemEvent(line);
    }

    if (line.type === "assistant" && isRecord(line.message)) {
      return parseMessageContent(line.message.content, "assistant");
    }

    if (line.type === "user" && isRecord(line.message)) {
      return parseMessageContent(line.message.content, "user");
    }

    if (line.type === "result") {
      const ok = line.is_error !== true && line.subtype === "success";

      return [
        {
          type: "result",
          ok,
          errorMessage: ok
            ? undefined
            : typeof line.result === "string" && line.result.length > 0
              ? line.result
              : `Claude Code run ended with ${String(line.subtype ?? "an unknown error")}.`,
        },
      ];
    }

    return [];
  },
};

function parseSystemEvent(line: Record<string, unknown>): AgentCliEvent[] {
  const events: AgentCliEvent[] = [];

  if (typeof line.session_id === "string" && line.session_id.length > 0) {
    events.push({ type: "session", sessionId: line.session_id });
  }

  if (line.subtype === "init") {
    events.push({
      type: "openwiki",
      event: {
        type: "debug",
        message: `claude-code session initialized model=${
          typeof line.model === "string" ? line.model : "unknown"
        }`,
      },
    });
  }

  return events;
}

function parseMessageContent(
  content: unknown,
  role: "assistant" | "user",
): AgentCliEvent[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const events: AgentCliEvent[] = [];

  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }

    if (role === "assistant" && block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      events.push({
        type: "openwiki",
        event: { source: "main", type: "text", text: block.text },
      });
    }

    if (role === "assistant" && block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      events.push({
        type: "openwiki",
        event: {
          type: "tool_start",
          call: `${block.name}(${formatToolArgs(block.input)})`,
          id: block.id,
          input: block.input,
          name: block.name,
        },
      });
    }

    if (role === "user" && block.type === "tool_result" && typeof block.tool_use_id === "string") {
      events.push({
        type: "openwiki",
        event: {
          type: "tool_end",
          id: block.tool_use_id,
          name: "tool",
          status: block.is_error === true ? "error" : "finished",
        },
      });
    }
  }

  return events;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
