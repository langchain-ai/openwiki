import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import type { BindToolsInput } from "@langchain/core/language_models/chat_models";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import {
  AIMessage,
  type AIMessageChunk,
  type BaseMessage,
  type ToolMessage,
} from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import type { Runnable } from "@langchain/core/runnables";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";

/**
 * CLI spawn + agent startup adds seconds over a raw API call, and a
 * rate-limited plan can queue, so the per-call ceiling is generous.
 */
// Late-run turns replay the whole transcript and can exceed 3 minutes on
// verification passes; 10 minutes matches the CLI's own request ceiling.
const DEFAULT_TIMEOUT_MS = 600_000;

type ClaudeToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

type StructuredReply = {
  kind: "text" | "tool_calls";
  text?: string;
  tool_calls?: { name: string; arguments: Record<string, unknown> }[];
};

/**
 * `claude -p` answers with one final message and cannot hand a tool call back
 * mid-turn, so tool calling is modelled as structured output instead: the
 * schema below lets the model either finish with prose or emit the calls it
 * wants, and `--json-schema` enforces the shape server-side rather than leaving
 * it to prompt-level parsing.
 */
function buildReplySchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["text", "tool_calls"] },
      text: { type: "string" },
      tool_calls: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            arguments: { type: "object", additionalProperties: true },
          },
          required: ["name", "arguments"],
          additionalProperties: false,
        },
      },
    },
    required: ["kind"],
    additionalProperties: false,
  };
}

function renderTools(tools: ClaudeToolSpec[]): string {
  if (tools.length === 0) {
    return "";
  }

  const rendered = tools
    .map(
      (tool) =>
        `### ${tool.name}\n${tool.description}\nparameters: ${JSON.stringify(tool.parameters)}`,
    )
    .join("\n\n");

  // The surrounding agent's system prompt tells the model to invoke these
  // directly. It cannot: `claude -p` exposes no such tools to the session.
  // Framing matters here: models that find an empty native roster infer a
  // misconfigured session and refuse. Explaining the mechanism (rather than
  // commanding "never report tools missing") is what defuses that inference.
  return (
    `## Tools\n\n` +
    `You are running non-interactively via the Claude Code CLI (\`claude -p\`), ` +
    `which cannot expose custom tools to a session — so your native tool roster ` +
    `is empty by design, not by misconfiguration. This process is one step inside ` +
    `an automated documentation harness that drives you in a loop.\n\n` +
    `How a tool call executes here:\n` +
    `1. You respond in the required JSON format with kind "tool_calls", naming a tool below with its arguments.\n` +
    `2. The harness parses that response, executes the real tool against the actual repository, and starts your next turn with the tool's output in the transcript.\n` +
    `3. You continue from that result.\n\n` +
    `Emitting the JSON IS the tool call: the filesystem access is real, it just ` +
    `happens between your turns instead of inside them. An empty native roster plus ` +
    `these instructions is the normal, working state of this harness.\n\n` +
    `There is no human in this session. Never ask for permission or confirmation, ` +
    `and never end a turn by announcing what you will do next — if work remains, ` +
    `emit the next tool call.\n\n${rendered}\n\n`
  );
}

/**
 * Flattens the exchange into a single prompt. `claude -p` takes one prompt
 * rather than a message array, so prior tool calls and their results are
 * replayed as transcript lines to keep the loop's history intact.
 */
function renderMessages(messages: BaseMessage[]): string {
  const lines: string[] = [];

  for (const message of messages) {
    const text =
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content);

    switch (message.getType()) {
      case "system":
        lines.push(`[instructions]\n${text}`);
        break;
      case "human":
        lines.push(`[user]\n${text}`);
        break;
      case "ai": {
        const calls = (message as AIMessage).tool_calls ?? [];

        if (calls.length > 0) {
          for (const call of calls) {
            lines.push(
              `[assistant called ${call.name}]\n${JSON.stringify(call.args)}`,
            );
          }
        }

        if (text.trim()) {
          lines.push(`[assistant]\n${text}`);
        }
        break;
      }
      case "tool": {
        const toolMessage = message as ToolMessage;

        lines.push(`[result of ${toolMessage.name ?? "tool"}]\n${text}`);
        break;
      }
      default:
        lines.push(text);
    }
  }

  return lines.join("\n\n");
}

function parseEnvelope(stdout: string): StructuredReply {
  const envelope = JSON.parse(stdout) as {
    structured_output?: StructuredReply;
    result?: string;
    is_error?: boolean;
  };

  // The CLI parses the schema-enforced payload for us; `result` is the same
  // JSON as a string and is only a fallback for older CLI builds.
  if (envelope.structured_output) {
    return envelope.structured_output;
  }

  if (typeof envelope.result === "string") {
    return JSON.parse(envelope.result) as StructuredReply;
  }

  throw new Error("claude -p returned no structured output");
}

export type ChatClaudeCliParams = BaseChatModelParams & {
  model: string;
  timeoutMs?: number;
};

/**
 * Runs Claude Code headlessly (`claude -p`) as a chat model, authenticating
 * through the same login as the interactive CLI rather than an API key.
 */
export class ChatClaudeCli extends BaseChatModel<BaseChatModelCallOptions> {
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly boundTools: ClaudeToolSpec[];

  constructor(params: ChatClaudeCliParams, boundTools: ClaudeToolSpec[] = []) {
    super(params);
    this.model = params.model;
    this.timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.boundTools = boundTools;
  }

  _llmType(): string {
    return "claude-cli";
  }

  override bindTools(
    tools: BindToolsInput[],
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, BaseChatModelCallOptions> {
    const specs = tools.map((tool) => {
      const { function: fn } = convertToOpenAITool(tool);

      return {
        name: fn.name,
        description: fn.description ?? "",
        parameters: fn.parameters ?? {},
      };
    });

    // Tools are carried on a fresh instance rather than mutated in place, so a
    // model bound with one toolset never leaks it into another binding.
    return new ChatClaudeCli(
      { model: this.model, timeoutMs: this.timeoutMs },
      specs,
    );
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const prompt = [
      renderTools(this.boundTools),
      renderMessages(messages),
      "\n\n## Your turn\n" +
        (this.boundTools.length > 0
          ? 'Act by returning kind="tool_calls" with the calls you want the ' +
            "harness to run — that is the only way to read files, search, or " +
            "write anything. Use kind=\"text\" only when the work is finished " +
            "or you genuinely need nothing from a tool."
          : 'Respond with kind="text" and your answer.'),
    ].join("");

    const reply = await this.runCli(prompt);

    if (reply.kind === "tool_calls" && reply.tool_calls?.length) {
      const message = new AIMessage({
        content: reply.text ?? "",
        tool_calls: reply.tool_calls.map((call) => ({
          id: `call_${randomUUID()}`,
          name: call.name,
          args: call.arguments ?? {},
          type: "tool_call" as const,
        })),
      });

      return { generations: [{ message, text: "" }] };
    }

    const text = reply.text ?? "";

    return {
      generations: [{ message: new AIMessage({ content: text }), text }],
    };
  }

  private runCli(prompt: string): Promise<StructuredReply> {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--model",
      this.model,
      // Without this the CLI loads the user's global MCP config into every
      // call — tool definitions that are pure overhead for a text-in/JSON-out
      // request.
      "--strict-mcp-config",
      // Claude Code's own built-in tools are not the tools this agent is
      // driving, and their definitions cost ~16k tokens per call. Verified
      // safe alongside --json-schema: structured output is still enforced.
      "--tools",
      "",
      "--json-schema",
      JSON.stringify(buildReplySchema()),
    ];

    return new Promise((resolve, reject) => {
      // A neutral cwd keeps the target repository's own CLAUDE.md and skills
      // out of a run whose context is supplied entirely by the prompt.
      const child = spawn("claude", args, { cwd: tmpdir() });
      let stdout = "";
      let stderr = "";

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`claude -p timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));

      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.on("close", (code) => {
        clearTimeout(timer);

        if (code !== 0) {
          reject(
            new Error(`claude exited ${code}: ${stderr.trim().slice(0, 300)}`),
          );
          return;
        }

        try {
          resolve(parseEnvelope(stdout));
        } catch (error) {
          reject(
            error instanceof Error
              ? error
              : new Error(`Unparseable claude -p output: ${String(error)}`),
          );
        }
      });

      // Prompt goes over stdin — agent prompts overflow argv limits.
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}
