import {
  createSdkMcpServer,
  query,
  type Options as ClaudeAgentOptions,
  type PermissionResult,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import {
  AIMessage,
  type BaseMessage,
  type ToolMessage,
} from "@langchain/core/messages";
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BaseChatModelParams,
  type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { ToolDefinition } from "@langchain/core/language_models/base";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { z } from "zod";

/**
 * MCP namespaces every tool it serves as `mcp__<server>__<tool>`. The bridge
 * has to strip that prefix before handing a tool call back to DeepAgents,
 * which only knows the bare name it registered.
 */
const MCP_SERVER_NAME = "openwiki";
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/**
 * Ceiling on Claude Code turns per LangChain generation. One turn is the happy
 * path; the extra headroom absorbs a refused built-in tool call, after which
 * the model retries with an OpenWiki tool. Capture still interrupts
 * immediately, so a healthy step never reaches this.
 */
const MAX_TURNS_PER_GENERATION = 6;

/**
 * Claude Code ships its own agent loop and toolset. The bridge only wants the
 * raw model turn, so every built-in tool is disabled — a stray `Read` or
 * `Bash` call would bypass OpenWiki's virtual filesystem backend and touch the
 * real repository. `ToolSearch` matters most: it defers MCP tools behind a
 * lookup step, which burns the single turn the bridge allows.
 */
const DISABLED_BUILTIN_TOOLS = [
  "Bash",
  "BashOutput",
  "Edit",
  "ExitPlanMode",
  "Glob",
  "Grep",
  "KillShell",
  "NotebookEdit",
  "Read",
  "SlashCommand",
  "Task",
  "TodoWrite",
  "ToolSearch",
  "WebFetch",
  "WebSearch",
  "Write",
] as const;

export type ChatClaudeCodeParams = BaseChatModelParams & {
  model: string;
  /**
   * Overrides the `claude` executable the SDK spawns. Only set when the CLI is
   * not on `PATH`; the SDK resolves it itself otherwise.
   */
  pathToClaudeCodeExecutable?: string;
  maxRetries?: number;
};

/**
 * Converts one JSON Schema property into a Zod type.
 *
 * `createSdkMcpServer` derives the JSON Schema it advertises to the model from
 * a Zod raw shape, but LangChain tools arrive carrying JSON Schema, so the
 * bridge has to round-trip through Zod. Only the subset DeepAgents actually
 * emits is handled; anything unrecognized degrades to `z.unknown()`, which
 * keeps the parameter visible to the model rather than dropping it.
 *
 * Note this schema is never used to *validate* a call: the MCP handler is
 * unreachable by construction (see `captureOnlyHandler`). It exists purely so
 * the advertised parameter list is faithful.
 */
export function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (typeof schema !== "object" || schema === null) {
    return z.unknown();
  }

  const node = schema as Record<string, unknown>;

  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const values = node.enum.filter(
      (value): value is string => typeof value === "string",
    );
    // Zod enums are string-only; a mixed or numeric enum falls back to unknown
    // rather than silently narrowing the model's options.
    if (values.length === node.enum.length) {
      return z.enum(values as [string, ...string[]]);
    }
    return z.unknown();
  }

  // `anyOf`/`oneOf` unions are flattened to unknown: the model still sees the
  // description, and the bridge never validates the value.
  if (node.anyOf || node.oneOf || node.allOf) {
    return z.unknown();
  }

  switch (node.type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(
        node.items === undefined ? z.unknown() : jsonSchemaToZod(node.items),
      );
    case "object": {
      const shape = jsonSchemaToZodShape(node);
      // An object declaring `additionalProperties: true` (or listing no
      // properties at all) is an intentional open bag — OpenWiki's
      // `openwiki_call_mcp_tool.args` forwards arbitrary connector arguments
      // through one. `z.object` would advertise it as closed, so the model
      // could not pass anything through it.
      if (
        node.additionalProperties === true ||
        Object.keys(shape).length === 0
      ) {
        return z.looseObject(shape);
      }
      return z.object(shape);
    }
    case "null":
      return z.null();
    default:
      return z.unknown();
  }
}

/**
 * Converts a JSON Schema object node into the raw Zod shape
 * `createSdkMcpServer` expects, preserving descriptions and optionality.
 */
export function jsonSchemaToZodShape(schema: unknown): z.ZodRawShape {
  if (typeof schema !== "object" || schema === null) {
    return {};
  }

  const node = schema as Record<string, unknown>;
  const properties = node.properties;

  if (typeof properties !== "object" || properties === null) {
    return {};
  }

  const required = new Set(
    Array.isArray(node.required)
      ? node.required.filter((name): name is string => typeof name === "string")
      : [],
  );

  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [name, rawProperty] of Object.entries(
    properties as Record<string, unknown>,
  )) {
    let zodType = jsonSchemaToZod(rawProperty);

    const description =
      typeof rawProperty === "object" &&
      rawProperty !== null &&
      typeof (rawProperty as Record<string, unknown>).description === "string"
        ? ((rawProperty as Record<string, unknown>).description as string)
        : undefined;

    if (description) {
      zodType = zodType.describe(description);
    }

    shape[name] = required.has(name) ? zodType : zodType.optional();
  }

  return shape;
}

/**
 * Normalizes the several shapes `bindTools` accepts into a flat
 * name/description/schema triple.
 */
type NormalizedTool = {
  name: string;
  description: string;
  parameters: unknown;
};

export function normalizeTool(tool: BindToolsInput): NormalizedTool | null {
  const candidate = tool as Record<string, unknown>;

  // OpenAI-style `{ type: "function", function: {...} }`.
  if (candidate.type === "function" && typeof candidate.function === "object") {
    const fn = (tool as ToolDefinition).function;
    return {
      name: fn.name,
      description: fn.description ?? "",
      parameters: fn.parameters,
    };
  }

  if (typeof candidate.name !== "string") {
    return null;
  }

  // StructuredTool instances expose a Zod schema; everything else already
  // carries JSON Schema on `schema`/`parameters`.
  const rawSchema = candidate.schema ?? candidate.parameters;

  return {
    name: candidate.name,
    description:
      typeof candidate.description === "string" ? candidate.description : "",
    parameters: normalizeToJsonSchema(rawSchema),
  };
}

/**
 * DeepAgents tools may carry a Zod v3 schema, a Zod v4 schema, or plain JSON
 * Schema. LangChain's own converter handles all three; `z.toJSONSchema` throws
 * on a v3 schema, which would silently degrade the tool to a parameterless
 * one and strand the model with no way to call it correctly.
 */
export function normalizeToJsonSchema(schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null) {
    return schema;
  }

  // Already plain JSON Schema.
  if (!("_def" in (schema as Record<string, unknown>))) {
    return schema;
  }

  return toJsonSchema(schema as Parameters<typeof toJsonSchema>[0]);
}

/**
 * Anthropic credentials that would override the CLI's own session.
 *
 * OpenWiki loads `~/.openwiki/.env` into `process.env` before the agent runs,
 * so a user who previously configured the `anthropic` provider still has
 * `ANTHROPIC_API_KEY` set. The spawned CLI prefers that key over its logged-in
 * session, which silently bills the API — and fails outright with "Credit
 * balance is too low" when the key is the reason the user switched to this
 * provider in the first place.
 */
const CONFLICTING_CREDENTIAL_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  // Set by the `anthropic` provider to reach a gateway. Inherited by the CLI it
  // would redirect the session's traffic to an endpoint that has no idea about
  // this login, so the run fails in a way that looks like a Claude Code bug.
  "ANTHROPIC_BASE_URL",
] as const;

/**
 * Builds the environment for the spawned CLI, stripping any Anthropic
 * credential that would shadow its session. Everything else (PATH, HOME, proxy
 * settings) is inherited so the CLI resolves normally.
 */
export function claudeCodeSessionEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...source };

  for (const key of CONFLICTING_CREDENTIAL_ENV_KEYS) {
    delete env[key];
  }

  return env;
}

export type CapturedToolCall = { name: string; args: unknown };

/**
 * Builds the `canUseTool` callback, the bridge's only interception point.
 *
 * Nothing is ever added to `allowedTools`: a bare entry there auto-approves the
 * call and shadows this callback entirely.
 *
 * The two branches must behave differently. An OpenWiki tool call is what the
 * bridge wants, so it is recorded and the turn is interrupted to hand it to
 * DeepAgents. A Claude Code built-in is refused *without* interrupting —
 * `disallowedTools` is a deny-list that cannot stay complete as the CLI gains
 * tools, so this is the real guard, and interrupting here would end the turn
 * with nothing captured and fail the step outright.
 */
export function createToolPermissionHandler(
  capturedToolCalls: CapturedToolCall[],
): (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<PermissionResult> {
  return (toolName, input) => {
    if (toolName.startsWith(MCP_TOOL_PREFIX)) {
      capturedToolCalls.push({
        name: toolName.slice(MCP_TOOL_PREFIX.length),
        args: input,
      });

      return Promise.resolve({
        behavior: "deny",
        message: "Captured by OpenWiki; executed by the OpenWiki agent loop.",
        interrupt: true,
      });
    }

    return Promise.resolve({
      behavior: "deny",
      message:
        `${toolName} is not available. Use only the OpenWiki tools provided ` +
        `to you (the mcp__${MCP_SERVER_NAME}__* tools).`,
    });
  };
}

/**
 * Decides whether a non-success ending is one the bridge deliberately causes.
 *
 * Two are expected. Denying a tool call with `interrupt` aborts the turn, which
 * the SDK reports as `error_during_execution` — that is the capture path, and
 * it is only legitimate when a tool call actually came back. A text-only answer
 * can also exhaust the single-turn cap (`error_max_turns`) after the model has
 * already said everything it intended to.
 *
 * Every other subtype — auth failure, billing, transport — is a real error.
 */
export function isExpectedTurnEnding(
  resultSubtype: string | undefined,
  capturedToolCallCount: number,
): boolean {
  if (capturedToolCallCount > 0) {
    return true;
  }

  return resultSubtype === "error_max_turns";
}

/**
 * The MCP handler must be unreachable: OpenWiki's agent loop owns tool
 * execution, so a call that reached here would run the tool twice. The bridge
 * denies every call in `canUseTool` before the handler can fire, and this
 * throw makes any regression in that interception loud instead of silent.
 */
function captureOnlyHandler(): Promise<never> {
  return Promise.reject(
    new Error(
      "OpenWiki tool handler was invoked inside Claude Code. Tool calls must be " +
        "captured by canUseTool and executed by the OpenWiki agent loop.",
    ),
  );
}

/**
 * Renders the LangChain transcript as a single user turn.
 *
 * The Agent SDK only accepts user messages — there is no way to inject prior
 * assistant turns — so a resumable session cannot be reconstructed from
 * LangChain's message list. Replaying the transcript each call keeps the model
 * stateless, which is what `_generate` promises and what makes OpenWiki's
 * checkpointer, summarization middleware, and `--update` resume behave. The
 * rendering is deterministic so the prefix stays byte-stable across steps and
 * Claude Code's prompt cache absorbs most of the repeated cost.
 */
function renderTranscript(messages: BaseMessage[]): string {
  const lines: string[] = [];

  for (const message of messages) {
    const type = message.getType();

    if (type === "system") {
      // Hoisted into the `systemPrompt` option instead.
      continue;
    }

    if (type === "tool") {
      const toolMessage = message as ToolMessage;
      lines.push(
        `<tool_result tool_call_id="${toolMessage.tool_call_id}">`,
        renderContent(toolMessage.content),
        "</tool_result>",
      );
      continue;
    }

    if (type === "ai") {
      const aiMessage = message as AIMessage;
      const text = renderContent(aiMessage.content).trim();

      if (text) {
        lines.push("<assistant>", text, "</assistant>");
      }

      for (const toolCall of aiMessage.tool_calls ?? []) {
        lines.push(
          `<tool_call id="${toolCall.id ?? ""}" name="${toolCall.name}">`,
          JSON.stringify(toolCall.args),
          "</tool_call>",
        );
      }
      continue;
    }

    lines.push("<user>", renderContent(message.content), "</user>");
  }

  return lines.join("\n");
}

function renderContent(content: BaseMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }
      const record = block as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") {
        return record.text;
      }
      return JSON.stringify(record);
    })
    .join("\n");
}

function extractSystemPrompt(messages: BaseMessage[]): string | undefined {
  const system = messages
    .filter((message) => message.getType() === "system")
    .map((message) => renderContent(message.content).trim())
    .filter(Boolean);

  return system.length > 0 ? system.join("\n\n") : undefined;
}

/**
 * A LangChain chat model backed by the local Claude Code CLI.
 *
 * Routes inference through the user's existing Claude Code session instead of
 * an Anthropic API key, so teams whose plan does not permit creating API keys
 * — or whose key has no credit — can still run OpenWiki. This mirrors the
 * `openai-chatgpt` and `copilot` providers, which reuse a ChatGPT and Copilot
 * subscription respectively.
 *
 * Claude Code owns its own agent loop, so the bridge constrains it to a single
 * model turn: OpenWiki's tools are exposed through an in-process MCP server,
 * every built-in tool is disabled, and `canUseTool` captures the resulting
 * `tool_use` and stops the turn before Claude Code can execute it. Execution
 * stays with DeepAgents, which is what keeps the virtual filesystem backend,
 * OKF middleware, and translation middleware in the loop.
 */
export class ChatClaudeCode extends BaseChatModel<BaseChatModelCallOptions> {
  model: string;

  pathToClaudeCodeExecutable?: string;

  private boundTools: NormalizedTool[] = [];

  constructor(params: ChatClaudeCodeParams) {
    super(params);
    this.model = params.model;
    this.pathToClaudeCodeExecutable = params.pathToClaudeCodeExecutable;
  }

  static lc_name(): string {
    return "ChatClaudeCode";
  }

  _llmType(): string {
    return "claude-code";
  }

  override bindTools(tools: BindToolsInput[]): this {
    const normalized = tools
      .map(normalizeTool)
      .filter((tool): tool is NormalizedTool => tool !== null);

    // BaseChatModel has no generic clone hook, so copy the instance and swap
    // the tool list. `bindTools` must not mutate the receiver: DeepAgents
    // rebinds per node and expects the original to stay tool-free.
    const bound = Object.create(
      Object.getPrototypeOf(this) as object,
    ) as ChatClaudeCode;
    Object.assign(bound, this);
    bound.boundTools = normalized;
    return bound as this;
  }

  private buildMcpServer() {
    const tools: Array<SdkMcpToolDefinition<z.ZodRawShape>> =
      this.boundTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: jsonSchemaToZodShape(tool.parameters),
        handler: captureOnlyHandler,
      }));

    return createSdkMcpServer({
      name: MCP_SERVER_NAME,
      version: "1.0.0",
      tools,
      // Without this the tools are deferred behind ToolSearch, which consumes
      // the single turn the bridge allows and yields no tool call.
      alwaysLoad: true,
    });
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const systemPrompt = extractSystemPrompt(messages);
    const prompt = renderTranscript(messages);

    const capturedToolCalls: Array<{ name: string; args: unknown }> = [];
    let textOutput = "";

    const queryOptions: ClaudeAgentOptions = {
      model: this.model,
      // Claude Code's own project instructions (CLAUDE.md, settings files)
      // would otherwise leak into OpenWiki's prompt and skew the wiki.
      settingSources: [],
      // Defense in depth only — the real guard is the `canUseTool` deny below,
      // because this list cannot stay complete as the CLI gains tools.
      disallowedTools: [...DISABLED_BUILTIN_TOOLS],
      // The bridge wants exactly one model turn, but a refused built-in costs a
      // turn before the model retries with an OpenWiki tool. Allow a few so
      // that retry can land; `canUseTool` still interrupts the moment a real
      // tool call is captured, so this is a ceiling rather than a target.
      maxTurns: MAX_TURNS_PER_GENERATION,
      env: claudeCodeSessionEnv(),
      abortController: options.signal
        ? toAbortController(options.signal)
        : undefined,
    };

    if (systemPrompt) {
      queryOptions.systemPrompt = systemPrompt;
    }

    if (this.pathToClaudeCodeExecutable) {
      queryOptions.pathToClaudeCodeExecutable = this.pathToClaudeCodeExecutable;
    }

    if (this.boundTools.length > 0) {
      queryOptions.mcpServers = { [MCP_SERVER_NAME]: this.buildMcpServer() };
    }

    // Registered even with no tools bound, so a built-in call is still refused
    // rather than executed against the real repository.
    queryOptions.canUseTool = createToolPermissionHandler(capturedToolCalls);

    const response = query({ prompt, options: queryOptions });

    // The SDK reports failures both as a thrown error and as a `result`
    // message. Record the subtype so the two expected non-success endings can
    // be told apart from a genuine failure (auth, billing, transport), which
    // must never be reported to the agent loop as a usable turn — doing so
    // would bake a truncated or empty section into the wiki.
    let resultSubtype: string | undefined;

    try {
      for await (const message of response) {
        if (message.type === "result") {
          resultSubtype = message.subtype;
          continue;
        }

        if (message.type !== "assistant") {
          continue;
        }

        for (const block of message.message.content ?? []) {
          if (block.type === "text" && typeof block.text === "string") {
            textOutput += block.text;
            await runManager?.handleLLMNewToken(block.text);
          }
        }
      }
    } catch (error) {
      if (!isExpectedTurnEnding(resultSubtype, capturedToolCalls.length)) {
        throw error;
      }
    }

    if (
      resultSubtype !== undefined &&
      resultSubtype !== "success" &&
      !isExpectedTurnEnding(resultSubtype, capturedToolCalls.length)
    ) {
      throw new Error(
        `Claude Code ended the turn with "${resultSubtype}" and produced no usable output.`,
      );
    }

    // A turn that produced neither a tool call nor text is not a usable model
    // response, whatever the SDK called it. Returning it would hand DeepAgents
    // an empty assistant message and quietly drop a wiki section.
    if (capturedToolCalls.length === 0 && textOutput.trim().length === 0) {
      throw new Error(
        `Claude Code returned no output for this turn (result: ${resultSubtype ?? "unknown"}).`,
      );
    }

    const toolCalls = capturedToolCalls.map((call, index) => ({
      id: `claude_code_tool_${index}_${Date.now()}`,
      name: call.name,
      args: (call.args ?? {}) as Record<string, unknown>,
      type: "tool_call" as const,
    }));

    const message = new AIMessage({
      content: textOutput,
      tool_calls: toolCalls,
    });

    return {
      generations: [
        {
          text: textOutput,
          message,
        },
      ],
    };
  }
}

/**
 * LangChain hands down an `AbortSignal`; the Agent SDK wants an
 * `AbortController`. Bridge the two so cancelling an OpenWiki run tears down
 * the spawned CLI process.
 */
function toAbortController(signal: AbortSignal): AbortController {
  const controller = new AbortController();

  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  return controller;
}
