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
 * Bob Shell's shell tool uses a Roo-style tool name, `execute_command`, and
 * its --allowed-tools flag matches tool names only -- there is no
 * command-level scoping, so parameterized entries like
 * `execute_command(rm -f ...)` never match and shell approval is all-or-
 * nothing (verified live: the exact-command form was rejected, the bare name
 * works). Shell is otherwise hard-blocked under --approval-mode auto_edit,
 * and allowing it is needed for cleanup of the temporary plan file
 * (`rm -f openwiki/_plan.md`) and for the agent to gather git evidence.
 * Bob Shell's file read/edit tools are auto-approved by --approval-mode
 * auto_edit rather than listed here; network tools stay unapproved on
 * purpose (headless runs cannot answer their confirmation prompts). This
 * unscoped shell grant matches the existing trust posture of the API-provider
 * path, where LocalShellBackend already executes arbitrary model-driven
 * shell commands in the working tree; Bob additionally confines writes to
 * the directory it was started in -- the runner spawns the CLI with cwd set
 * to the repository root and never passes --include-directories, so that
 * boundary is exactly the target repository. Bob refuses non-default
 * approval modes in untrusted folders, so the repository must be trusted in
 * Bob (run `bob` there once).
 */
export const IBM_BOB_ALLOWED_TOOLS = "execute_command";

export const ibmBobAdapter: AgentCliAdapter = {
  id: "ibm-bob",

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
      "--output-format",
      "stream-json",
      "--approval-mode",
      "auto_edit",
      "--chat-mode",
      "advanced",
      "--allowed-tools",
      IBM_BOB_ALLOWED_TOOLS,
    ];

    if (spec.modelId !== "default") {
      args.push("--model", spec.modelId);
    }

    if (spec.resumeSessionId) {
      args.push("--resume", spec.resumeSessionId);
      // Bob rejects a resumed session unless the message arrives via -p;
      // its stdin detection for that check doesn't work, and an empty -p
      // value is also rejected, so the composed payload must ride here.
      args.push("-p", composePayload(spec));
    }

    return args;
  },

  buildStdin(spec: EngineRunSpec): string {
    // Bob Shell has no --append-system-prompt equivalent, so the system
    // prompt travels as a preamble of the stdin payload. On resume the
    // payload instead goes via -p (see buildArgs), so stdin stays empty --
    // sending it on both would make Bob concatenate the payload twice.
    if (spec.resumeSessionId) {
      return "";
    }

    return composePayload(spec);
  },

  parseEvent(line: unknown): AgentCliEvent[] {
    if (!isRecord(line) || typeof line.type !== "string") {
      return [];
    }

    if (line.type === "init") {
      return parseInitEvent(line);
    }

    if (line.type === "message") {
      return parseMessageEvent(line);
    }

    if (
      line.type === "tool_use" &&
      typeof line.tool_id === "string" &&
      typeof line.tool_name === "string"
    ) {
      return [
        {
          type: "openwiki",
          event: {
            type: "tool_start",
            call: `${line.tool_name}(${formatToolArgs(line.parameters)})`,
            id: line.tool_id,
            input: line.parameters,
            name: line.tool_name,
          },
        },
      ];
    }

    if (line.type === "tool_result" && typeof line.tool_id === "string") {
      return [
        {
          type: "openwiki",
          event: {
            type: "tool_end",
            id: line.tool_id,
            name: "tool",
            status: line.status === "error" ? "error" : "finished",
          },
        },
      ];
    }

    if (line.type === "error") {
      return [
        {
          type: "openwiki",
          event: {
            type: "debug",
            message: `ibm-bob ${
              typeof line.severity === "string" ? line.severity : "error"
            }: ${typeof line.message === "string" ? line.message : "unknown"}`,
          },
        },
      ];
    }

    if (line.type === "result") {
      const ok = line.status === "success";
      const error = isRecord(line.error) ? line.error : undefined;

      return [
        {
          type: "result",
          ok,
          errorMessage: ok
            ? undefined
            : typeof error?.message === "string" && error.message.length > 0
              ? error.message
              : `IBM Bob run ended with ${String(line.status ?? "an unknown error")}.`,
        },
      ];
    }

    return [];
  },
};

function parseInitEvent(line: Record<string, unknown>): AgentCliEvent[] {
  const events: AgentCliEvent[] = [];

  if (typeof line.session_id === "string" && line.session_id.length > 0) {
    events.push({ type: "session", sessionId: line.session_id });
  }

  events.push({
    type: "openwiki",
    event: {
      type: "debug",
      message: `ibm-bob session initialized model=${
        typeof line.model === "string" ? line.model : "unknown"
      }`,
    },
  });

  return events;
}

function parseMessageEvent(line: Record<string, unknown>): AgentCliEvent[] {
  if (
    line.role !== "assistant" ||
    typeof line.content !== "string" ||
    line.content.length === 0
  ) {
    return [];
  }

  return [
    {
      type: "openwiki",
      event: { source: "main", type: "text", text: line.content },
    },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function composePayload(spec: EngineRunSpec): string {
  return `${spec.systemPrompt}\n\n${spec.prompt}`;
}
