import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { ChatAnthropic } from "@langchain/anthropic";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { ChatOpenAI } from "@langchain/openai";
import { ChatOpenRouter } from "@langchain/openrouter";
import { ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { ChatResult, ChatGenerationChunk } from "@langchain/core/outputs";
import { createDeepAgent, LocalShellBackend } from "deepagents";
import { DEBUG_ENV_KEYS, loadOpenWikiEnv, openWikiEnvDir } from "../env.js";
import { isFileNotFoundError } from "../fs-errors.js";
import { createSystemPrompt, createUserPrompt } from "./prompt.js";
import type {
  OpenWikiCommand,
  OpenWikiRunEvent,
  OpenWikiRunOptions,
  OpenWikiRunResult,
} from "./types.js";
import {
  ANTHROPIC_BASE_URL_ENV_KEY,
  getDefaultModelId,
  getProviderApiKeyEnvKey,
  getProviderBaseUrlEnvKey,
  getProviderConfig,
  getProviderLabel,
  isValidModelId,
  normalizeModelId,
  OPENAI_COMPATIBLE_BASE_URL_ENV_KEY,
  OPENROUTER_API_KEY_ENV_KEY,
  OPENROUTER_BASE_URL,
  OPENROUTER_FALLBACK_MODEL_IDS,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
  providerRequiresBaseUrl,
  resolveConfiguredProvider,
  resolveProviderBaseUrl,
  type OpenWikiProvider,
} from "../constants.js";
import {
  createOpenWikiContentSnapshot,
  getUpdateNoopStatus,
  createRunContext,
  shouldCheckUpdateNoop,
  writeLastUpdateMetadata,
} from "./utils.js";

export async function runOpenWikiAgent(
  command: OpenWikiCommand,
  cwd = process.cwd(),
  options: OpenWikiRunOptions = {},
): Promise<OpenWikiRunResult> {
  emitDebug(options, `command=${command}`);
  emitDebug(options, `cwd=${cwd}`);
  emitDebug(
    options,
    `userMessage=${options.userMessage ? "provided" : "not-provided"}`,
  );
  emitDebug(options, `userMessage.followup=${options.isFollowup === true}`);
  emitDebug(options, `env.beforeLoad ${formatEnvironmentDebug()}`);

  await loadOpenWikiEnv();
  emitDebug(options, "env=loaded ~/.openwiki/.env");
  emitDebug(options, `env.afterLoad ${formatEnvironmentDebug()}`);

  if (command === "update" && shouldCheckUpdateNoop(options)) {
    const noopStatus = await getUpdateNoopStatus(cwd);

    if (noopStatus.shouldSkip) {
      const message =
        "No repository changes detected since the last OpenWiki update; skipping agent run.";
      emitDebug(options, `update.noop gitHead=${noopStatus.gitHead}`);
      options.onEvent?.({ type: "text", text: message });

      return {
        command,
        model: noopStatus.model,
        skipped: true,
      };
    }

    emitDebug(options, `update.noop=false reason=${noopStatus.reason}`);
  } else if (command === "update") {
    emitDebug(options, "update.noop=false reason=user message provided");
  }

  const provider = resolveConfiguredProvider();
  const providerBaseUrl = resolveProviderBaseUrl(provider);
  emitDebug(options, `provider=${provider}`);
  if (providerBaseUrl) {
    emitDebug(options, `provider.baseUrl=${JSON.stringify(providerBaseUrl)}`);
  }
  ensureProviderKey(provider);
  emitDebug(options, `credentials=${provider} key present`);
  ensureProviderBaseUrl(provider);
  const modelId = resolveModelId(options, provider);
  emitDebug(options, `model=${modelId}`);

  const debugFetchCapture = installOpenRouterDebugFetch(options);

  try {
    return await runOpenWikiAgentWithModelFallbacks(
      command,
      cwd,
      options,
      provider,
      modelId,
      debugFetchCapture,
    );
  } catch (error) {
    attachOpenRouterDebugInfo(error, debugFetchCapture.getLastFailure());
    throw error;
  } finally {
    debugFetchCapture.restore();
  }
}

async function runOpenWikiAgentWithModelFallbacks(
  command: OpenWikiCommand,
  cwd: string,
  options: OpenWikiRunOptions,
  provider: OpenWikiProvider,
  modelId: string,
  debugFetchCapture: OpenRouterFetchCapture,
): Promise<OpenWikiRunResult> {
  const modelAttempts = createModelRoute(provider, modelId);
  let lastError: unknown = null;

  for (const [attemptIndex, attemptModelId] of modelAttempts.entries()) {
    const attemptOptions = createAttemptOptions(options, attemptIndex);

    debugFetchCapture.clearLastFailure();

    if (attemptIndex > 0) {
      emitDebug(
        options,
        `model.retry attempt=${attemptIndex + 1} model=${attemptModelId}`,
      );
    }

    try {
      return await runOpenWikiAgentCore(
        command,
        cwd,
        attemptOptions,
        provider,
        attemptModelId,
      );
    } catch (error) {
      const failure = debugFetchCapture.getLastFailure();

      attachOpenRouterDebugInfo(error, failure);
      lastError = error;

      if (
        !shouldRetryOpenRouterServerError(
          failure,
          attemptIndex,
          modelAttempts.length,
        )
      ) {
        throw error;
      }

      emitDebug(
        options,
        `model.retrying status=${failure?.response?.status ?? "unknown"} next=${
          modelAttempts[attemptIndex + 1]
        }`,
      );
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("OpenWiki run failed after model fallback attempts.");
}

async function runOpenWikiAgentCore(
  command: OpenWikiCommand,
  cwd: string,
  options: OpenWikiRunOptions,
  provider: OpenWikiProvider,
  modelId: string,
): Promise<OpenWikiRunResult> {
  const context = await createRunContext(command, cwd);
  emitDebug(options, "context=created");
  const openWikiSnapshotBefore =
    command === "chat" ? null : await createOpenWikiContentSnapshot(cwd);
  emitDebug(options, "openwiki.snapshot=created");
  const model = createModel(provider, modelId);
  emitDebug(options, `model.provider=${provider}`);
  if (provider === "openrouter") {
    emitDebug(
      options,
      `openrouter.route=fallback models=${JSON.stringify(
        createModelRoute(provider, modelId),
      )}`,
    );
  }
  emitDebug(options, "model=initialized");
  const checkpointer = await createCheckpointer();
  emitDebug(options, `checkpointer=${formatUrlDebugValue(checkpointPath)}`);
  const threadId = options.threadId ?? createThreadId(cwd, createRunThreadId());
  emitDebug(options, `thread=${threadId}`);
  const agent = createDeepAgent({
    model,
    tools: [],
    checkpointer,
    backend: new LocalShellBackend({
      maxOutputBytes: 100_000,
      rootDir: cwd,
      timeout: 120,
      virtualMode: true,
    }),
    systemPrompt: createSystemPrompt(command),
  });
  emitDebug(options, "agent=created");

  const input = {
    messages: [
      {
        role: "user",
        content: createRunUserMessage(command, cwd, context, options),
      },
    ],
  };

  emitDebug(options, "stream=opening modes=messages,tools subgraphs=true");
  const stream = await agent.stream(input, {
    configurable: {
      thread_id: threadId,
    },
    streamMode: ["messages", "tools"],
    subgraphs: true,
  });
  emitDebug(options, "stream=started modes=messages,tools subgraphs=true");

  let lastToolCallId: string | undefined;
  let lastToolName: string | undefined;
  let unhandledChunkCount = 0;

  try {
    for await (const chunk of stream) {
      const event = parseStreamEvent(chunk);

      // Track the most recently started tool so we can emit a targeted
      // error event if the stream fails mid-execution.
      if (event?.type === "tool_start") {
        lastToolCallId = event.id;
        lastToolName = event.name;
      }

      if (event) {
        options.onEvent?.(event);
      } else if (options.debug && unhandledChunkCount < 3) {
        emitDebug(
          options,
          `stream.unhandledChunk ${describeStreamChunkShape(chunk)}`,
        );
        unhandledChunkCount += 1;
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    emitDebug(options, `stream.error ${errorMessage}`);

    // Emit a tool_end error event for the last tracked tool so the UI
    // marks it as failed rather than leaving it spinning indefinitely.
    if (lastToolCallId) {
      options.onEvent?.({
        type: "tool_end",
        id: lastToolCallId,
        name: lastToolName ?? "tool",
        status: "error",
      });
    }

    // Emit the error as text so the user sees what went wrong.
    options.onEvent?.({
      type: "text",
      text: `\n\n**Tool execution error:** ${errorMessage}`,
    });

    throw error;
  }
  emitDebug(options, "stream=completed");
  await chmodIfExists(checkpointPath, 0o600);

  if (
    command !== "chat" &&
    openWikiSnapshotBefore !== (await createOpenWikiContentSnapshot(cwd))
  ) {
    await writeLastUpdateMetadata(command, cwd, modelId);
    emitDebug(options, "metadata=written");
  } else {
    emitDebug(
      options,
      command === "chat"
        ? "metadata=skipped command=chat"
        : "metadata=skipped openwiki=unchanged",
    );
  }

  return {
    command,
    model: modelId,
  };
}

function createAttemptOptions(
  options: OpenWikiRunOptions,
  attemptIndex: number,
): OpenWikiRunOptions {
  if (attemptIndex === 0) {
    return options;
  }

  return {
    ...options,
    threadId: options.threadId
      ? `${options.threadId}-retry-${attemptIndex}`
      : undefined,
  };
}

const checkpointPath = path.join(openWikiEnvDir, "openwiki.sqlite");

function createRunUserMessage(
  command: OpenWikiCommand,
  cwd: string,
  context: Awaited<ReturnType<typeof createRunContext>>,
  options: OpenWikiRunOptions,
): string {
  if (options.isFollowup === true && options.userMessage?.trim()) {
    return options.userMessage.trim();
  }

  return `
${createUserPrompt(command, context, options.userMessage ?? null)}

Repository root:
${cwd}

Runtime note:
- Treat the repository root above as the only project you are documenting.
- Filesystem tools use a virtual root: / means ${cwd}.
- For ls, read_file, write_file, edit_file, glob, and grep, use virtual paths such as /README.md, /agent/agents/main.py, and /openwiki/quickstart.md.
- Do not pass host absolute paths to filesystem tools. A host absolute path will be treated as a virtual path and will write to the wrong location.
- Shell execute commands run on the host. For execute, use cd ${cwd} before repository commands.
- Do not search parent directories or unrelated repositories.
`.trim();
}

async function createCheckpointer(): Promise<SqliteSaver> {
  await mkdir(openWikiEnvDir, {
    recursive: true,
    mode: 0o700,
  });
  await chmodIfExists(openWikiEnvDir, 0o700);

  return SqliteSaver.fromConnString(checkpointPath);
}

async function chmodIfExists(filePath: string, mode: number): Promise<void> {
  try {
    await chmod(filePath, mode);
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }
}

export function createOpenWikiThreadId(cwd = process.cwd()): string {
  return createThreadId(cwd, createRunThreadId());
}

function createThreadId(cwd: string, runId: string): string {
  const digest = createHash("sha256").update(path.resolve(cwd)).digest("hex");

  return `openwiki-${digest.slice(0, 32)}-${runId}`;
}

function createRunThreadId(): string {
  return `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function emitDebug(options: OpenWikiRunOptions, message: string): void {
  if (!options.debug) {
    return;
  }

  options.onEvent?.({
    type: "debug",
    message,
  });
}

function ensureProviderKey(provider: OpenWikiProvider): void {
  const config = getProviderConfig(provider);

  // Local providers (Ollama, LM Studio) do not require API keys.
  if (config.requiresApiKey === false) {
    return;
  }

  const apiKeyEnvKey = getProviderApiKeyEnvKey(provider);

  if (!process.env[apiKeyEnvKey]) {
    throw new Error(
      `${apiKeyEnvKey} is required to run OpenWiki with ${getProviderLabel(provider)}.`,
    );
  }
}

function ensureProviderBaseUrl(provider: OpenWikiProvider): void {
  if (!providerRequiresBaseUrl(provider)) {
    return;
  }

  if (!resolveProviderBaseUrl(provider)) {
    const baseUrlEnvKey = getProviderBaseUrlEnvKey(provider) ?? "base URL";

    throw new Error(
      `${baseUrlEnvKey} is required to run OpenWiki with ${getProviderLabel(provider)}.`,
    );
  }
}

function resolveModelId(
  options: OpenWikiRunOptions,
  provider: OpenWikiProvider,
): string {
  const rawModelId =
    options.modelId ??
    process.env[OPENWIKI_MODEL_ID_ENV_KEY] ??
    getDefaultModelId(provider);
  const modelId = normalizeModelId(rawModelId);

  if (!isValidModelId(modelId)) {
    throw new Error(
      `Invalid model ID configured in ${OPENWIKI_MODEL_ID_ENV_KEY}.`,
    );
  }

  return modelId;
}

function createModel(provider: OpenWikiProvider, modelId: string) {
  if (provider === "anthropic") {
    const baseURL = resolveProviderBaseUrl(provider);

    return new SafeDocumentChatAnthropic(modelId, {
      apiKey: process.env[getProviderApiKeyEnvKey(provider)],
      ...(baseURL ? { anthropicApiUrl: baseURL } : {}),
    });
  }

  if (provider === "openrouter") {
    const models = createModelRoute(provider, modelId);

    return new ChatOpenRouter({
      apiKey: process.env[OPENROUTER_API_KEY_ENV_KEY],
      baseURL: OPENROUTER_BASE_URL,
      model: modelId,
      models,
      route: "fallback",
      siteName: "OpenWiki",
    });
  }

  const baseURL = resolveProviderBaseUrl(provider);
  const baseConfig = {
    apiKey: process.env[getProviderApiKeyEnvKey(provider)],
    configuration: baseURL
      ? {
          baseURL,
        }
      : undefined,
    model: modelId,
  };

  // For OpenAI-compatible providers (openai-compatible, ollama, lm-studio),
  // wrap ChatOpenAI with a subclass that strips non-text content blocks from
  // tool messages. This prevents "raw file block leaks" that occur when
  // LangChain wraps binary tool results in file content blocks that the
  // OpenAI API rejects in tool role messages.
  if (
    provider === "openai-compatible" ||
    provider === "ollama" ||
    provider === "lm-studio"
  ) {
    return new SafeToolMessageChatOpenAI(baseConfig);
  }

  return new ChatOpenAI(baseConfig);
}

/**
 * A ChatAnthropic subclass that sanitizes non-PDF file/document blocks
 * from tool messages before they are sent to the Anthropic API.
 *
 * The Anthropic Messages API **only** accepts `application/pdf` as a valid
 * media type for document blocks. When deepagents reads a file with an
 * unknown extension (e.g. `Makefile`, `Dockerfile`, `uv.lock`), it defaults
 * the MIME type to `application/octet-stream`. LangChain's Anthropic converter
 * creates `{type: "document", source: {type: "base64", media_type: "application/octet-stream"}}`
 * blocks from this, which the Anthropic API rejects with 400:
 *   "media_type: Input should be 'application/pdf'"
 *
 * By replacing non-PDF file/document blocks in tool messages with a text
 * description before they reach the converter, we prevent this crash while
 * preserving PDF document support.
 */
class SafeDocumentChatAnthropic extends ChatAnthropic {
  /**
   * Returns true for mime types the Anthropic API supports in document blocks:
   * PDF, or empty/undefined (which defaults to PDF).
   */
  private static _isAllowedAnthropicDocumentMimeType(
    mimeType: string | undefined | null,
  ): boolean {
    return (
      !mimeType ||
      mimeType === "application/pdf" ||
      mimeType.startsWith("image/")
    );
  }

  /**
   * Checks if a content block is a file/document block that would fail the
   * Anthropic API.
   */
  private static _isUnsupportedAnthropicFileBlock(block: unknown): boolean {
    if (typeof block !== "object" || block === null) return false;

    // Data content block (LangChain internal format via isDataContentBlock)
    if (
      "source_type" in block &&
      block.source_type === "base64" &&
      "mime_type" in block
    ) {
      return !SafeDocumentChatAnthropic._isAllowedAnthropicDocumentMimeType(
        typeof block.mime_type === "string" ? block.mime_type : undefined,
      );
    }

    if (!("type" in block)) return false;

    // File content block (OpenAI-compatible format used by deepagents)
    if (block.type === "file") {
      const mimeType =
        "mimeType" in block && typeof block.mimeType === "string"
          ? block.mimeType
          : "mime_type" in block && typeof block.mime_type === "string"
            ? block.mime_type
            : undefined;

      return !SafeDocumentChatAnthropic._isAllowedAnthropicDocumentMimeType(
        mimeType,
      );
    }

    // Document block already in Anthropic format
    if (
      block.type === "document" &&
      "source" in block &&
      typeof block.source === "object" &&
      block.source !== null
    ) {
      const source = block.source as Record<string, unknown>;

      if (source.type === "base64") {
        const mediaType =
          "media_type" in source && typeof source.media_type === "string"
            ? source.media_type
            : undefined;

        return !SafeDocumentChatAnthropic._isAllowedAnthropicDocumentMimeType(
          mediaType,
        );
      }

      if (source.type === "text") {
        const mediaType =
          "media_type" in source && typeof source.media_type === "string"
            ? source.media_type
            : undefined;

        return (
          mediaType !== undefined &&
          mediaType !== "" &&
          mediaType !== "text/plain"
        );
      }
    }

    return false;
  }

  /**
   * Strips or replaces non-PDF file/document content blocks from tool
   * messages so they pass Anthropic API validation.
   */
  private _sanitizeToolMessages(messages: BaseMessage[]): BaseMessage[] {
    return messages.map((msg) => {
      if (!ToolMessage.isInstance(msg)) return msg;

      const content = msg.content;
      if (typeof content === "string" || !Array.isArray(content)) {
        return msg;
      }

      const hasUnsupportedBlock = content.some((block) =>
        SafeDocumentChatAnthropic._isUnsupportedAnthropicFileBlock(block),
      );

      if (!hasUnsupportedBlock) return msg;

      const sanitizedContent = content.map((block) => {
        if (SafeDocumentChatAnthropic._isUnsupportedAnthropicFileBlock(block)) {
          const mimeType = _extractUnsupportedMimeType(block);

          return {
            type: "text",
            text: `[Binary file content omitted — Anthropic only supports PDF document blocks (received: ${mimeType})]`,
          };
        }

        return block;
      });

      return new ToolMessage({
        content: sanitizedContent,
        tool_call_id: msg.tool_call_id,
        name: msg.name,
        status: msg.status,
        additional_kwargs: msg.additional_kwargs,
        response_metadata: msg.response_metadata,
        id: msg.id,
      });
    });
  }

  override async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    return super._generate(
      this._sanitizeToolMessages(messages),
      options,
      runManager,
    );
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    yield* super._streamResponseChunks(
      this._sanitizeToolMessages(messages),
      options,
      runManager,
    );
  }
}

/**
 * A ChatOpenAI subclass that strips non-text content blocks from tool messages
 * before they are serialized for the API.
 *
 * LangChain's ChatOpenAI converter (non-v1 path) converts data content blocks
 * (e.g., file blocks) via `completionsApiContentBlockConverter.fromStandardFileBlock`,
 * producing `{type: "file", file: {file_data: "data:...,base64,...", filename: "..."}}`
 * parts inside tool messages. The OpenAI Chat Completions API rejects non-text
 * content in tool role messages, which breaks proxies like LiteLLM/Bedrock with
 * errors like "BadRequestError: file_data and file_id cannot both be None".
 *
 * By filtering tool message content to only text blocks before messages reach
 * the converter, we prevent this leak while preserving all other functionality.
 */
class SafeToolMessageChatOpenAI extends ChatOpenAI {
  /**
   * Strips non-text content blocks from tool messages.
   * Shared between _generate and _streamResponseChunks overrides.
   */
  private _sanitizeToolMessages(messages: BaseMessage[]): BaseMessage[] {
    return messages.map((msg) => {
      if (!ToolMessage.isInstance(msg)) {
        return msg;
      }

      const content = msg.content;

      // If content is already a string, nothing to fix
      if (typeof content === "string") {
        return msg;
      }

      // content is an array of content blocks — keep only text blocks
      if (Array.isArray(content)) {
        const textBlocks = content.filter(
          (block) =>
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            block.type === "text",
        );
        const textContent = textBlocks
          .map((block) =>
            typeof block === "object" &&
            block !== null &&
            "text" in block &&
            typeof block.text === "string"
              ? block.text
              : "",
          )
          .join("\n");

        return new ToolMessage({
          content: textContent || "",
          tool_call_id: msg.tool_call_id,
          name: msg.name,
          status: msg.status,
          additional_kwargs: msg.additional_kwargs,
          response_metadata: msg.response_metadata,
          id: msg.id,
        });
      }

      return msg;
    });
  }

  override async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    return super._generate(
      this._sanitizeToolMessages(messages),
      options,
      runManager,
    );
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    yield* super._streamResponseChunks(
      this._sanitizeToolMessages(messages),
      options,
      runManager,
    );
  }
}

/**
 * Extracts the unsupported MIME type from a file/document block for error
 * reporting. Returns "unknown" if the type cannot be determined.
 */
function _extractUnsupportedMimeType(block: Record<string, unknown>): string {
  if ("mimeType" in block && typeof block.mimeType === "string") {
    return block.mimeType;
  }

  if ("mime_type" in block && typeof block.mime_type === "string") {
    return block.mime_type;
  }

  if (
    "source" in block &&
    typeof block.source === "object" &&
    block.source !== null
  ) {
    const source = block.source as Record<string, unknown>;

    if ("media_type" in source && typeof source.media_type === "string") {
      return source.media_type;
    }
  }

  return "unknown";
}

function createModelRoute(
  provider: OpenWikiProvider,
  modelId: string,
): string[] {
  if (provider !== "openrouter") {
    return [modelId];
  }

  return Array.from(new Set([modelId, ...OPENROUTER_FALLBACK_MODEL_IDS]));
}

function shouldRetryOpenRouterServerError(
  failure: OpenRouterFetchFailure | null,
  attemptIndex: number,
  attemptCount: number,
): boolean {
  const status = failure?.response?.status;

  return (
    attemptIndex < attemptCount - 1 &&
    typeof status === "number" &&
    status >= 500 &&
    status < 600
  );
}

type NormalizedStreamEvent = {
  isSubgraph: boolean;
  mode: string;
  payload: unknown;
};

function parseStreamEvent(chunk: unknown): OpenWikiRunEvent | null {
  const streamEvent = normalizeStreamEvent(chunk);

  if (!streamEvent) {
    return null;
  }

  if (streamEvent.mode === "messages") {
    const text = extractMessageText(streamEvent.payload);

    return text.length > 0
      ? {
          source: streamEvent.isSubgraph ? "subgraph" : "main",
          type: "text",
          text,
        }
      : null;
  }

  if (streamEvent.mode === "tools") {
    return parseToolStreamEvent(streamEvent.payload);
  }

  return null;
}

function normalizeStreamEvent(chunk: unknown): NormalizedStreamEvent | null {
  if (Array.isArray(chunk)) {
    if (chunk.length < 2) {
      return null;
    }

    const [mode, payload] = normalizeStreamChunk(chunk);

    return typeof mode === "string"
      ? {
          isSubgraph: isSubgraphStreamChunk(chunk),
          mode,
          payload,
        }
      : null;
  }

  if (!isRecord(chunk)) {
    return null;
  }

  const toolEvent = getStringRecordValue(chunk, "event");

  if (toolEvent?.startsWith("on_tool_")) {
    return {
      isSubgraph: false,
      mode: "tools",
      payload: chunk,
    };
  }

  const method = getStringRecordValue(chunk, "method");

  if (!method) {
    return null;
  }

  return {
    isSubgraph: false,
    mode: method,
    payload: getProtocolEventPayload(chunk),
  };
}

function normalizeStreamChunk(chunk: unknown[]): [unknown, unknown] {
  if (Array.isArray(chunk[0]) && chunk.length >= 3) {
    return [chunk[1], chunk[2]];
  }

  return [chunk[0], chunk[1]];
}

function isSubgraphStreamChunk(chunk: unknown[]): boolean {
  if (!Array.isArray(chunk[0]) || chunk.length < 3) {
    return false;
  }

  return chunk[0].length > 1;
}

function extractMessageText(payload: unknown): string {
  return extractMessageTextValue(payload, new Set());
}

function extractMessageTextValue(payload: unknown, seen: Set<object>): string {
  if (typeof payload === "string") {
    return payload;
  }

  if (Array.isArray(payload)) {
    if (payload.length === 2 && isStreamMessageTuplePayload(payload)) {
      return extractMessageTextValue(payload[0], seen);
    }

    for (const item of payload) {
      const text = extractMessageTextValue(item, seen);

      if (text.length > 0) {
        return text;
      }
    }

    return payload.map((item) => extractContentBlockText(item, seen)).join("");
  }

  if (!isRecord(payload) || seen.has(payload)) {
    return "";
  }

  seen.add(payload);

  const protocolText = extractProtocolMessageText(payload, seen);

  if (protocolText !== null) {
    return protocolText;
  }

  if (isRecord(payload.chunk)) {
    const text = extractMessageTextValue(payload.chunk, seen);

    if (text.length > 0) {
      return text;
    }
  }

  if (isRecord(payload.message)) {
    const text = extractMessageTextValue(payload.message, seen);

    if (text.length > 0) {
      return text;
    }
  }

  if (!shouldReadMessageRecord(payload)) {
    return "";
  }

  const contentText = extractContentText(payload.content, seen);

  if (contentText.length > 0) {
    return contentText;
  }

  for (const key of [
    "text",
    "output",
    "generations",
    "messages",
    "kwargs",
    "lc_kwargs",
  ]) {
    const text = extractMessageTextValue(payload[key], seen);

    if (text.length > 0) {
      return text;
    }
  }

  return "";
}

function isStreamMessageTuplePayload(payload: unknown[]): boolean {
  const [message, metadata] = payload;

  if (!isRecord(metadata) || !isMessageLikeRecord(message)) {
    return false;
  }

  if (
    "langgraph_node" in metadata ||
    "run_id" in metadata ||
    "tags" in metadata ||
    "metadata" in metadata
  ) {
    return true;
  }

  return (
    "langgraph_node" in message ||
    "checkpoint_ns" in message ||
    "thread_id" in message
  );
}

function isMessageLikeRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  return (
    "content" in value ||
    "text" in value ||
    "kwargs" in value ||
    "lc_kwargs" in value ||
    typeof value._getType === "function" ||
    getMessageRole(value) !== null ||
    hasSerializedMessageId(value)
  );
}

function extractProtocolMessageText(
  payload: Record<string, unknown>,
  seen: Set<object>,
): string | null {
  const event = getStringRecordValue(payload, "event");

  if (!event) {
    return null;
  }

  if (event === "content-block-delta") {
    return extractContentDeltaText(payload.delta, seen);
  }

  if (event === "content-block-start") {
    return extractContentText(payload.content, seen);
  }

  if (
    event === "message-start" ||
    event === "message-finish" ||
    event === "content-block-finish" ||
    event === "error"
  ) {
    return "";
  }

  return null;
}

function extractContentText(content: unknown, seen: Set<object>): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((block) => extractContentBlockText(block, seen))
      .join("");
  }

  if (isRecord(content)) {
    return extractContentBlockText(content, seen);
  }

  return "";
}

function extractContentDeltaText(delta: unknown, seen: Set<object>): string {
  if (typeof delta === "string") {
    return delta;
  }

  if (!isRecord(delta)) {
    return "";
  }

  const type = getStringRecordValue(delta, "type");

  if (type === "text-delta") {
    return typeof delta.text === "string" ? delta.text : "";
  }

  if (type === "block-delta") {
    return extractContentBlockText(delta.fields, seen);
  }

  if (typeof delta.text === "string") {
    return delta.text;
  }

  if (typeof delta.delta === "string") {
    return delta.delta;
  }

  return "";
}

function extractContentBlockText(block: unknown, seen: Set<object>): string {
  if (typeof block === "string") {
    return block;
  }

  if (!isRecord(block)) {
    return "";
  }

  const type = getStringRecordValue(block, "type");

  if (type?.includes("tool") || type?.includes("reasoning")) {
    return "";
  }

  for (const key of ["text", "content", "output_text"]) {
    const text = block[key];

    if (typeof text === "string") {
      return text;
    }
  }

  if (isRecord(block.fields)) {
    return extractContentBlockText(block.fields, seen);
  }

  if (isRecord(block.delta)) {
    return extractContentDeltaText(block.delta, seen);
  }

  return "";
}

function shouldReadMessageRecord(value: Record<string, unknown>): boolean {
  const role = getMessageRole(value);

  return role === null || role === "ai" || role === "assistant";
}

function getMessageRole(value: Record<string, unknown>): string | null {
  for (const key of ["role", "type"]) {
    const role = getStringRecordValue(value, key);

    if (isMessageRole(role)) {
      return role;
    }
  }

  const serializedType = getSerializedMessageType(value);

  if (serializedType === "AIMessage" || serializedType === "AIMessageChunk") {
    return "ai";
  }

  if (
    serializedType === "HumanMessage" ||
    serializedType === "SystemMessage" ||
    serializedType === "ToolMessage"
  ) {
    return serializedType.replace("Message", "").toLowerCase();
  }

  const getType = value._getType;

  if (typeof getType !== "function") {
    return null;
  }

  try {
    const role: unknown = getType.call(value);

    return isMessageRole(role) ? role : null;
  } catch {
    return null;
  }
}

function hasSerializedMessageId(value: Record<string, unknown>): boolean {
  return getSerializedMessageType(value) !== null;
}

function getSerializedMessageType(
  value: Record<string, unknown>,
): string | null {
  if (!Array.isArray(value.id)) {
    return null;
  }

  return (
    value.id
      .filter((part): part is string => typeof part === "string")
      .at(-1) ?? null
  );
}

function isMessageRole(value: unknown): value is string {
  return (
    value === "ai" ||
    value === "assistant" ||
    value === "human" ||
    value === "system" ||
    value === "tool"
  );
}

function getProtocolEventPayload(event: Record<string, unknown>): unknown {
  const params = event.params;

  if (isRecord(params) && "data" in params) {
    return params.data;
  }

  if ("data" in event) {
    return event.data;
  }

  if ("payload" in event) {
    return event.payload;
  }

  return event;
}

function parseToolStreamEvent(payload: unknown): OpenWikiRunEvent | null {
  if (!isRecord(payload)) {
    return null;
  }

  const event = getStringRecordValue(payload, "event");

  if (event === "on_tool_start" || event === "tool-started") {
    const name =
      getStringRecordValue(payload, "name") ??
      getStringRecordValue(payload, "tool_name") ??
      "tool";
    const id =
      getStringRecordValue(payload, "toolCallId") ??
      getStringRecordValue(payload, "tool_call_id") ??
      createSyntheticToolCallId(name, payload.input);

    return {
      type: "tool_start",
      call: `${formatToolCallName(name)}(${formatToolArgs(payload.input)})`,
      id,
      input: payload.input,
      name,
    };
  }

  if (
    event === "on_tool_end" ||
    event === "tool-finished" ||
    event === "on_tool_error" ||
    event === "tool-error"
  ) {
    const name =
      getStringRecordValue(payload, "name") ??
      getStringRecordValue(payload, "tool_name") ??
      "tool";
    const id =
      getStringRecordValue(payload, "toolCallId") ??
      getStringRecordValue(payload, "tool_call_id") ??
      createSyntheticToolCallId(name, payload.input);

    return {
      type: "tool_end",
      id,
      name,
      status:
        event === "on_tool_error" || event === "tool-error"
          ? "error"
          : "finished",
    };
  }

  return null;
}

function formatToolCallName(name: string): string {
  return name === "execute" ? "Execute" : name;
}

function formatToolArgs(input: unknown): string {
  const value = parseStringifiedJson(input);

  if (isRecord(value)) {
    return Object.entries(value)
      .map(([key, argValue]) => `${key}=${formatToolValue(argValue)}`)
      .join(", ");
  }

  if (Array.isArray(value)) {
    return value.map(formatToolValue).join(", ");
  }

  if (value === undefined || value === null) {
    return "";
  }

  return formatToolValue(value);
}

function formatToolValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  return JSON.stringify(value) ?? String(value);
}

function parseStringifiedJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function createSyntheticToolCallId(name: string, input: unknown): string {
  return `${name}:${formatToolValue(input)}`;
}

function getStringRecordValue(
  value: Record<string, unknown>,
  key: string,
): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function describeStreamChunkShape(chunk: unknown): string {
  if (Array.isArray(chunk)) {
    return `array(length=${chunk.length}, items=${chunk
      .slice(0, 3)
      .map(describeValueShape)
      .join(",")})`;
  }

  return describeValueShape(chunk);
}

function describeValueShape(value: unknown): string {
  if (Array.isArray(value)) {
    return `array(length=${value.length})`;
  }

  if (isRecord(value)) {
    const keys = Object.keys(value);
    const suffix = keys.length > 8 ? ",..." : "";

    return `object(keys=${keys.slice(0, 8).join(",")}${suffix})`;
  }

  return typeof value;
}

type OpenRouterFetchCapture = {
  clearLastFailure: () => void;
  getLastFailure: () => OpenRouterFetchFailure | null;
  restore: () => void;
};

type OpenRouterFetchFailure = {
  fetchError?: string;
  request: OpenRouterRequestSummary;
  response?: OpenRouterResponseSummary;
};

type OpenRouterRequestSummary = {
  bodyBytes?: number;
  messageChars?: number;
  messageCount?: number;
  method: string;
  model?: string;
  stream?: boolean;
  toolCount?: number;
  toolNames?: string[];
  url: string;
};

type OpenRouterResponseSummary = {
  bodyPreview: string;
  headers: Record<string, string>;
  status: number;
  statusText: string;
};

const OPENROUTER_DEBUG_PROPERTY = "openRouterDebug";
const OPENROUTER_DEBUG_BODY_LIMIT = 4_000;

function installOpenRouterDebugFetch(
  options: OpenWikiRunOptions,
): OpenRouterFetchCapture {
  const originalFetch = globalThis.fetch;
  let lastFailure: OpenRouterFetchFailure | null = null;

  globalThis.fetch = (async (input, init) => {
    if (!isOpenRouterFetchInput(input)) {
      return originalFetch(input, init);
    }

    const request = summarizeOpenRouterRequest(input, init);

    try {
      const response = await originalFetch(input, init);

      if (!response.ok) {
        lastFailure = {
          request,
          response: {
            bodyPreview: await readResponseBodyPreview(response),
            headers: getSafeResponseHeaders(response.headers),
            status: response.status,
            statusText: response.statusText,
          },
        };
        emitDebug(
          options,
          `openrouter.http status=${response.status} statusText=${JSON.stringify(
            response.statusText,
          )}`,
        );
      }

      return response;
    } catch (error) {
      lastFailure = {
        fetchError: error instanceof Error ? error.message : String(error),
        request,
      };
      throw error;
    }
  }) satisfies typeof fetch;

  return {
    clearLastFailure: () => {
      lastFailure = null;
    },
    getLastFailure: () => lastFailure,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function attachOpenRouterDebugInfo(
  error: unknown,
  failure: OpenRouterFetchFailure | null,
): void {
  if (!failure || !isRecord(error)) {
    return;
  }

  error[OPENROUTER_DEBUG_PROPERTY] = failure;
}

function isOpenRouterFetchInput(input: Parameters<typeof fetch>[0]): boolean {
  const url = getFetchInputUrl(input);

  return (
    url !== null &&
    url.startsWith(OPENROUTER_BASE_URL) &&
    url.includes("/chat/completions")
  );
}

function getFetchInputUrl(input: Parameters<typeof fetch>[0]): string | null {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return "url" in input && typeof input.url === "string" ? input.url : null;
}

function summarizeOpenRouterRequest(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): OpenRouterRequestSummary {
  const body = typeof init?.body === "string" ? init.body : null;
  const parsedBody = parseJsonRecord(body);
  const toolNames = getOpenRouterToolNames(parsedBody?.tools);

  return {
    bodyBytes: body === null ? undefined : Buffer.byteLength(body, "utf8"),
    messageChars: getOpenRouterMessageChars(parsedBody?.messages),
    messageCount: Array.isArray(parsedBody?.messages)
      ? parsedBody.messages.length
      : undefined,
    method: init?.method ?? "GET",
    model: typeof parsedBody?.model === "string" ? parsedBody.model : undefined,
    stream:
      typeof parsedBody?.stream === "boolean" ? parsedBody.stream : undefined,
    toolCount: toolNames.length,
    toolNames: toolNames.slice(0, 20),
    url: formatOpenRouterDebugUrl(getFetchInputUrl(input) ?? "unknown"),
  };
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (value === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;

    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getOpenRouterToolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools
    .map((tool) => {
      if (!isRecord(tool) || !isRecord(tool.function)) {
        return null;
      }

      return typeof tool.function.name === "string" ? tool.function.name : null;
    })
    .filter((name): name is string => name !== null);
}

function getOpenRouterMessageChars(messages: unknown): number | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }

  return messages.reduce<number>((total, message) => {
    if (!isRecord(message)) {
      return total;
    }

    return total + countMessageContentChars(message.content);
  }, 0);
}

function countMessageContentChars(content: unknown): number {
  if (typeof content === "string") {
    return content.length;
  }

  if (Array.isArray(content)) {
    return content.reduce<number>(
      (total, block) => total + countMessageContentChars(block),
      0,
    );
  }

  if (!isRecord(content)) {
    return 0;
  }

  return Object.entries(content).reduce((total, [key, value]) => {
    if (key === "text" || key === "content") {
      return total + countMessageContentChars(value);
    }

    return total;
  }, 0);
}

async function readResponseBodyPreview(response: Response): Promise<string> {
  try {
    const body = await response.clone().text();
    const sanitizedBody = sanitizeOpenRouterResponseBody(body);

    return sanitizedBody.length <= OPENROUTER_DEBUG_BODY_LIMIT
      ? sanitizedBody
      : `${sanitizedBody.slice(0, OPENROUTER_DEBUG_BODY_LIMIT - 3)}...`;
  } catch (error) {
    return `Unable to read response body: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

export function sanitizeOpenRouterResponseBody(body: string): string {
  return body.replace(
    /"([^"]*(?:api[-_]?key|authorization|bearer|password|secret|token|user_id)[^"]*)"\s*:\s*"[^"]*"/giu,
    (_, key: string) => `${JSON.stringify(key)}:"[REDACTED]"`,
  );
}

function getSafeResponseHeaders(headers: Headers): Record<string, string> {
  const safeHeaders: Record<string, string> = {};

  for (const key of ["cf-ray", "content-type", "request-id", "x-request-id"]) {
    const value = headers.get(key);

    if (value) {
      safeHeaders[key] = value;
    }
  }

  return safeHeaders;
}

function formatOpenRouterDebugUrl(value: string): string {
  try {
    const url = new URL(value);

    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";

    return url.toString();
  } catch {
    return value;
  }
}

function formatEnvironmentDebug(): string {
  return DEBUG_ENV_KEYS.map(
    (key) => `${key}:${formatDebugValue(key, process.env[key])}`,
  ).join(" ");
}

function formatDebugValue(key: string, value: string | undefined): string {
  if (value === undefined) {
    return "unset";
  }

  if (
    key === "LANGCHAIN_ENDPOINT" ||
    key === ANTHROPIC_BASE_URL_ENV_KEY ||
    key === OPENAI_COMPATIBLE_BASE_URL_ENV_KEY
  ) {
    return formatUrlDebugValue(value);
  }

  if (key.endsWith("_API_KEY")) {
    return `set(length=${value.length})`;
  }

  if (key === OPENWIKI_MODEL_ID_ENV_KEY || key === OPENWIKI_PROVIDER_ENV_KEY) {
    return `set(value=${JSON.stringify(value)})`;
  }

  if (value.length <= 10) {
    return `set(length=${value.length})`;
  }

  return `set(length=${value.length}, preview=${JSON.stringify(
    `${value.slice(0, 6)}...${value.slice(-4)}`,
  )})`;
}

function formatUrlDebugValue(value: string): string {
  try {
    const url = new URL(value);
    const redacted: string[] = [];

    if (url.username || url.password) {
      redacted.push("auth");
      url.username = "";
      url.password = "";
    }

    if (url.search) {
      redacted.push("query");
      url.search = "";
    }

    if (url.hash) {
      redacted.push("hash");
      url.hash = "";
    }

    const redactionSuffix =
      redacted.length > 0 ? `, redacted=${redacted.join("+")}` : "";

    return `set(url=${JSON.stringify(url.toString())}${redactionSuffix})`;
  } catch {
    return `set(length=${value.length}, preview=${JSON.stringify(
      `${value.slice(0, 6)}...${value.slice(-4)}`,
    )})`;
  }
}
