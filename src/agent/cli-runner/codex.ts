import type { CliEngineAdapter, CliParsedEvent, CliRunSpec } from "./types.js";

export const codexAdapter: CliEngineAdapter = {
  cliCommand: "codex",
  engine: "codex-cli",

  buildArgs(spec: CliRunSpec): string[] {
    const flags = [
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "--model",
      spec.modelId,
    ];

    return spec.resumeSessionId
      ? ["exec", "resume", spec.resumeSessionId, ...flags, "-"]
      : ["exec", ...flags, "-"];
  },

  stdinPayload(spec: CliRunSpec): string {
    return `${spec.systemPrompt}\n\n${spec.userPrompt}`;
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
      return [debugEvent(`codex.unparsed ${trimmed.slice(0, 200)}`)];
    }

    if (!isRecord(payload) || typeof payload.type !== "string") {
      return [];
    }

    switch (payload.type) {
      case "thread.started":
        return typeof payload.thread_id === "string"
          ? [{ kind: "session", sessionId: payload.thread_id }]
          : [];
      case "item.started":
        return parseItem(payload.item, "start");
      case "item.completed":
        return parseItem(payload.item, "end");
      case "turn.completed":
        return [debugEvent(`codex.usage ${JSON.stringify(payload.usage)}`)];
      case "turn.failed":
      case "error":
        return [
          {
            kind: "result",
            isError: true,
            message: extractErrorMessage(payload),
          },
        ];
      default:
        return [];
    }
  },
};

function parseItem(item: unknown, phase: "start" | "end"): CliParsedEvent[] {
  if (!isRecord(item) || typeof item.type !== "string") {
    return [];
  }

  if (item.type === "reasoning") {
    return [];
  }

  if (item.type === "agent_message") {
    return phase === "end" && typeof item.text === "string" && item.text
      ? [{ kind: "event", event: { type: "text", text: item.text } }]
      : [];
  }

  const id = typeof item.id === "string" ? item.id : `codex:${item.type}`;

  if (phase === "start") {
    return [
      {
        kind: "event",
        event: {
          type: "tool_start",
          call: formatItemCall(item),
          id,
          input: item,
          name: item.type,
        },
      },
    ];
  }

  const failed =
    item.status === "failed" ||
    (typeof item.exit_code === "number" && item.exit_code !== 0);

  return [
    {
      kind: "event",
      event: {
        type: "tool_end",
        id,
        name: item.type,
        status: failed ? "error" : "finished",
      },
    },
  ];
}

function formatItemCall(item: Record<string, unknown>): string {
  if (typeof item.command === "string") {
    return `Execute(${JSON.stringify(item.command)})`;
  }

  return `${String(item.type)}(${JSON.stringify(item).slice(0, 160)})`;
}

function extractErrorMessage(payload: Record<string, unknown>): string {
  if (isRecord(payload.error) && typeof payload.error.message === "string") {
    return payload.error.message;
  }

  return typeof payload.message === "string"
    ? payload.message
    : "codex exec failed";
}

function debugEvent(message: string): CliParsedEvent {
  return { kind: "event", event: { type: "debug", message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
