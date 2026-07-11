import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AgentCliAdapter,
  AgentCliEvent,
  AgentCliInstallStatus,
  AgentCliStreamParser,
  EngineRunSpec,
} from "./types.js";

const execFileAsync = promisify(execFile);

/** Default max agent turns for documentation runs. Override with OPENWIKI_GROK_BUILD_MAX_TURNS. */
export const DEFAULT_GROK_BUILD_MAX_TURNS = 50;

/**
 * Grok Build headless adapter.
 *
 * Auth is the CLI's own subscription login (`grok login` → ~/.grok/auth.json).
 * OpenWiki never sees or stores an xAI API key for this provider.
 *
 * Streaming text is coalesced: Grok emits many partial `text` tokens across
 * intermediate turns (planning, tool narration). OpenWiki only surfaces the
 * text buffered after the last tool *start* (or the whole run if no tools),
 * so `-p` / the TUI show a clean final answer instead of a jumbled stream.
 */
export const grokBuildAdapter: AgentCliAdapter = {
  id: "grok-build",

  async detectInstall(binary: string): Promise<AgentCliInstallStatus> {
    try {
      const { stdout } = await execFileAsync(binary, ["--version"], {
        timeout: 15_000,
      });

      return { found: true, version: stdout.trim().split("\n")[0]?.trim() };
    } catch {
      return { found: false };
    }
  },

  buildArgs(spec: EngineRunSpec, promptFilePath: string): string[] {
    const args = [
      "--prompt-file",
      promptFilePath,
      "--output-format",
      "streaming-json",
      "--always-approve",
      "--max-turns",
      String(resolveMaxTurns()),
      "--disable-web-search",
    ];

    if (spec.modelId.length > 0) {
      args.push("--model", spec.modelId);
    }

    if (spec.resumeSessionId) {
      args.push("--resume", spec.resumeSessionId);
    }

    return args;
  },

  createParser(): AgentCliStreamParser {
    return createGrokBuildStreamParser();
  },
};

/**
 * Stateful parser for Grok Build streaming-json.
 *
 * Text is buffered. Tool *starts* (not tool ends) clear the buffer so
 * pre-tool planning is dropped but a final answer that arrives before a
 * trailing tool_end is kept. On `end` / flush the buffer is emitted once.
 */
export function createGrokBuildStreamParser(): AgentCliStreamParser {
  let finalCandidate = "";
  let finished = false;

  function finalTextEvent(): AgentCliEvent[] {
    const text = finalCandidate;
    finalCandidate = "";

    if (text.trim().length === 0) {
      return [];
    }

    return [
      {
        type: "openwiki",
        event: { source: "main", type: "text", text },
      },
    ];
  }

  return {
    parse(line: unknown): AgentCliEvent[] {
      if (finished) {
        return [];
      }

      if (!isRecord(line) || typeof line.type !== "string") {
        if (isFinalResultObject(line)) {
          finished = true;
          return parseFinalResultObject(line);
        }

        return [];
      }

      if (line.type === "text" && typeof line.data === "string") {
        finalCandidate += line.data;
        return [];
      }

      if (line.type === "thought") {
        if (typeof line.data === "string" && line.data.length > 0) {
          return [
            {
              type: "openwiki",
              event: {
                type: "debug",
                message: `grok-build.thought=${JSON.stringify(line.data)}`,
              },
            },
          ];
        }

        return [];
      }

      if (
        line.type === "tool_start" ||
        line.type === "tool_use" ||
        line.type === "tool_call"
      ) {
        // New tool use starts a work phase — drop pre-tool narration only.
        finalCandidate = "";
        return parseToolStartEvent(line);
      }

      if (line.type === "tool_end" || line.type === "tool_result") {
        // Do not clear finalCandidate: trailing tool_end after the answer
        // must not discard the buffered user-visible text.
        return parseToolEndEvent(line);
      }

      if (line.type === "error") {
        finished = true;
        const message =
          typeof line.message === "string" && line.message.length > 0
            ? line.message
            : typeof line.data === "string" && line.data.length > 0
              ? line.data
              : "Grok Build reported an error.";

        return [{ type: "result", ok: false, errorMessage: message }];
      }

      if (line.type === "end") {
        finished = true;
        return [...finalTextEvent(), ...parseEndEvent(line)];
      }

      return [];
    },

    flush(): AgentCliEvent[] {
      if (finished) {
        return [];
      }

      finished = true;
      return finalTextEvent();
    },
  };
}

function resolveToolName(line: Record<string, unknown>): string {
  if (typeof line.name === "string" && line.name.length > 0) {
    return line.name;
  }

  if (typeof line.tool === "string" && line.tool.length > 0) {
    return line.tool;
  }

  return "tool";
}

function resolveToolId(line: Record<string, unknown>, name: string): string {
  if (typeof line.id === "string" && line.id.length > 0) {
    return line.id;
  }

  if (typeof line.toolCallId === "string" && line.toolCallId.length > 0) {
    return line.toolCallId;
  }

  // Same fallback as tool_start so toolNames.get(id) matches tool_end.
  return name;
}

function parseToolStartEvent(line: Record<string, unknown>): AgentCliEvent[] {
  const name = resolveToolName(line);
  const id = resolveToolId(line, name);

  return [
    {
      type: "openwiki",
      event: {
        type: "tool_start",
        call: name,
        id,
        input: line.input ?? line.args ?? line.parameters,
        name,
      },
    },
  ];
}

function parseToolEndEvent(line: Record<string, unknown>): AgentCliEvent[] {
  const name = resolveToolName(line);
  const id = resolveToolId(line, name);

  return [
    {
      type: "openwiki",
      event: {
        type: "tool_end",
        id,
        name,
        status:
          line.is_error === true || line.error === true ? "error" : "finished",
      },
    },
  ];
}

function resolveMaxTurns(): number {
  const raw = process.env.OPENWIKI_GROK_BUILD_MAX_TURNS;
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);

  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_GROK_BUILD_MAX_TURNS;
}

function parseEndEvent(line: Record<string, unknown>): AgentCliEvent[] {
  const events: AgentCliEvent[] = [];

  if (typeof line.sessionId === "string" && line.sessionId.length > 0) {
    events.push({ type: "session", sessionId: line.sessionId });
  }

  const stopReason =
    typeof line.stopReason === "string" ? line.stopReason : "unknown";
  const ok = isSuccessfulStopReason(stopReason);

  events.push({
    type: "result",
    ok,
    errorMessage: ok
      ? undefined
      : `Grok Build run ended with stopReason=${stopReason}.`,
  });

  return events;
}

function isFinalResultObject(value: unknown): value is Record<string, unknown> {
  // Require stopReason plus either sessionId or text so mid-stream untyped
  // objects cannot be mistaken for a terminal non-streaming result.
  return (
    isRecord(value) &&
    value.type === undefined &&
    typeof value.stopReason === "string" &&
    value.stopReason.length > 0 &&
    (typeof value.sessionId === "string" || typeof value.text === "string")
  );
}

function parseFinalResultObject(
  line: Record<string, unknown>,
): AgentCliEvent[] {
  const events: AgentCliEvent[] = [];

  if (typeof line.text === "string" && line.text.length > 0) {
    events.push({
      type: "openwiki",
      event: { source: "main", type: "text", text: line.text },
    });
  }

  if (typeof line.sessionId === "string" && line.sessionId.length > 0) {
    events.push({ type: "session", sessionId: line.sessionId });
  }

  const stopReason =
    typeof line.stopReason === "string" ? line.stopReason : "EndTurn";
  const ok = isSuccessfulStopReason(stopReason);

  events.push({
    type: "result",
    ok,
    errorMessage: ok
      ? undefined
      : `Grok Build run ended with stopReason=${stopReason}.`,
  });

  return events;
}

function isSuccessfulStopReason(stopReason: string): boolean {
  const normalized = stopReason.toLowerCase();

  // max_turns is intentionally NOT success: a truncated documentation run
  // should fail so OpenWiki does not record .last-update.json for partial work.
  return (
    normalized === "endturn" ||
    normalized === "end_turn" ||
    normalized === "completed" ||
    normalized === "success"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
