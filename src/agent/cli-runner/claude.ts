import type { CliEngineAdapter, CliParsedEvent, CliRunSpec } from "./types.js";

const CLAUDE_ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "LS",
  "Write",
  "Edit",
  "MultiEdit",
  "TodoWrite",
  "Task",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git diff:*)",
  "Bash(git status:*)",
  "Bash(git blame:*)",
  "Bash(rg:*)",
  "Bash(ls:*)",
  // Exact plan-file cleanup commands referenced by the CLI prompt.
  "Bash(rm -f openwiki/_plan.md)",
  "Bash(rm -f _plan.md)",
].join(",");

export const claudeAdapter: CliEngineAdapter = {
  cliCommand: "claude",
  engine: "claude-code",

  buildArgs(spec: CliRunSpec): string[] {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      spec.modelId,
      "--permission-mode",
      "acceptEdits",
      "--append-system-prompt",
      spec.systemPrompt,
      "--allowedTools",
      CLAUDE_ALLOWED_TOOLS,
    ];

    if (spec.resumeSessionId) {
      args.push("--resume", spec.resumeSessionId);
    }

    return args;
  },

  parseLine(line: string): CliParsedEvent[] {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      return [];
    }

    let payload: unknown;

    try {
      payload = JSON.parse(trimmed);
    } catch {
      return [debugEvent(`claude.unparsed ${trimmed.slice(0, 200)}`)];
    }

    if (!isRecord(payload) || typeof payload.type !== "string") {
      return [];
    }

    switch (payload.type) {
      case "system":
        return payload.subtype === "init" &&
          typeof payload.session_id === "string"
          ? [{ kind: "session", sessionId: payload.session_id }]
          : [];
      case "assistant":
        return parseAssistantMessage(payload);
      case "user":
        return parseToolResults(payload);
      case "result": {
        const isError =
          payload.is_error === true || payload.subtype !== "success";

        return [
          {
            kind: "result",
            isError,
            message: typeof payload.result === "string" ? payload.result : "",
          },
          debugEvent(
            `claude.result subtype=${String(payload.subtype)} cost=${String(
              payload.total_cost_usd,
            )} turns=${String(payload.num_turns)}`,
          ),
        ];
      }
      default:
        return [];
    }
  },
};

function parseAssistantMessage(
  payload: Record<string, unknown>,
): CliParsedEvent[] {
  const events: CliParsedEvent[] = [];

  for (const block of getContentBlocks(payload)) {
    if (block.type === "text" && typeof block.text === "string") {
      if (block.text.length > 0) {
        events.push({
          kind: "event",
          event: { type: "text", text: block.text },
        });
      }
    } else if (
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      events.push({
        kind: "event",
        event: {
          type: "tool_start",
          call: `${block.name}(${formatToolInput(block.input)})`,
          id: block.id,
          input: block.input,
          name: block.name,
        },
      });
    }
  }

  return events;
}

function parseToolResults(payload: Record<string, unknown>): CliParsedEvent[] {
  const events: CliParsedEvent[] = [];

  for (const block of getContentBlocks(payload)) {
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      events.push({
        kind: "event",
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

function getContentBlocks(
  payload: Record<string, unknown>,
): Record<string, unknown>[] {
  if (!isRecord(payload.message) || !Array.isArray(payload.message.content)) {
    return [];
  }

  return payload.message.content.filter(isRecord);
}

function formatToolInput(input: unknown): string {
  const formatted = JSON.stringify(input) ?? "";

  return formatted.length > 200 ? `${formatted.slice(0, 197)}...` : formatted;
}

function debugEvent(message: string): CliParsedEvent {
  return { kind: "event", event: { type: "debug", message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
