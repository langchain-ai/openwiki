import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { createDeepAgent, LocalShellBackend } from "deepagents";
import { loadOpenWikiEnv, openWikiEnvDir } from "../env.js";
import { createSystemPrompt, createUserPrompt } from "./prompt.js";
import type {
  OpenWikiCommand,
  OpenWikiRunEvent,
  OpenWikiRunOptions,
  OpenWikiRunResult,
} from "./types.js";
import {
  BASETEN_API_KEY_ENV_KEY,
  FIREWORKS_API_KEY_ENV_KEY,
  getDefaultModelId,
  getProviderApiKeyEnvKey,
  getProviderConfig,
  getProviderLabel,
  isValidModelId,
  normalizeModelId,
  OPENAI_API_KEY_ENV_KEY,
  ANTHROPIC_API_KEY_ENV_KEY,
  OPENROUTER_API_KEY_ENV_KEY,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
  resolveConfiguredProvider,
  type OpenWikiProvider,
} from "../constants.js";
import {
  createOpenWikiContentSnapshot,
  createRunContext,
  writeLastUpdateMetadata,
} from "./utils.js";
import { createModel, shouldUseOpenAiResponsesApi } from "./model.js";
import { createModelRoute } from "./model-route.js";
import {
  attachProviderDebugInfo,
  installProviderDebugFetch,
  type ProviderFetchCapture,
  type ProviderFetchFailure,
} from "./provider-debug.js";

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
  const provider = resolveConfiguredProvider();
  const providerConfig = getProviderConfig(provider);
  emitDebug(options, `provider=${provider}`);
  if (providerConfig.baseURL) {
    emitDebug(
      options,
      `provider.baseUrl=${JSON.stringify(providerConfig.baseURL)}`,
    );
  }
  ensureProviderKey(provider);
  emitDebug(options, `credentials=${provider} key present`);
  const modelId = resolveModelId(options, provider);
  emitDebug(options, `model=${modelId}`);

  const debugFetchCapture = installProviderDebugFetch({
    onDebug: options.debug
      ? (message) => emitDebug(options, message)
      : undefined,
  });
  const tracerWarningFilter = installLangChainTracerWarningFilter();

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
    attachProviderDebugInfo(error, debugFetchCapture.getLastFailure());
    throw error;
  } finally {
    debugFetchCapture.restore();
    tracerWarningFilter.restore();
  }
}

async function runOpenWikiAgentWithModelFallbacks(
  command: OpenWikiCommand,
  cwd: string,
  options: OpenWikiRunOptions,
  provider: OpenWikiProvider,
  modelId: string,
  debugFetchCapture: ProviderFetchCapture,
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

      attachProviderDebugInfo(error, failure);
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
  const model = await createModel(provider, modelId);
  emitDebug(options, `model.provider=${provider}`);
  if (provider === "openai" && shouldUseOpenAiResponsesApi(modelId)) {
    emitDebug(
      options,
      "model.openai.useResponsesApi=true (required for deepagents read_file binary content with gpt-5/o-series)",
    );
  }
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

  let unhandledChunkCount = 0;

  for await (const chunk of stream) {
    const event = parseStreamEvent(chunk);

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
  process.stderr.write(`[openwiki:debug] ${message}\n`);
}

function installLangChainTracerWarningFilter(): { restore: () => void } {
  const originalConsoleError = console.error;

  console.error = (...args: Parameters<typeof console.error>) => {
    if (isLangChainTracerEndWarning(args)) {
      return;
    }

    originalConsoleError(...args);
  };

  return {
    restore: () => {
      console.error = originalConsoleError;
    },
  };
}

function isLangChainTracerEndWarning(
  args: Parameters<typeof console.error>,
): boolean {
  const message = args.map(formatConsoleErrorArg).join(" ");

  return (
    message.includes("Error in handler LangChainTracer") &&
    /handle(?:Tool|Chain|LLM)End/u.test(message) &&
    /No (?:tool|chain|LLM) run to end/u.test(message)
  );
}

function formatConsoleErrorArg(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Error) {
    return value.message;
  }

  return "";
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function ensureProviderKey(provider: OpenWikiProvider): void {
  const apiKeyEnvKey = getProviderApiKeyEnvKey(provider);

  if (!process.env[apiKeyEnvKey]) {
    throw new Error(
      `${apiKeyEnvKey} is required to run OpenWiki with ${getProviderLabel(provider)}.`,
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

function shouldRetryOpenRouterServerError(
  failure: ProviderFetchFailure | null,
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
    const role = getType.call(value);

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

function formatEnvironmentDebug(): string {
  const keys = [
    OPENWIKI_PROVIDER_ENV_KEY,
    BASETEN_API_KEY_ENV_KEY,
    FIREWORKS_API_KEY_ENV_KEY,
    OPENAI_API_KEY_ENV_KEY,
    ANTHROPIC_API_KEY_ENV_KEY,
    OPENROUTER_API_KEY_ENV_KEY,
    OPENWIKI_MODEL_ID_ENV_KEY,
    "LANGCHAIN_TRACING_V2",
    "LANGCHAIN_PROJECT",
    "LANGCHAIN_ENDPOINT",
  ];

  return keys
    .map((key) => `${key}:${formatDebugValue(key, process.env[key])}`)
    .join(" ");
}

function formatDebugValue(key: string, value: string | undefined): string {
  if (value === undefined) {
    return "unset";
  }

  if (key === "LANGCHAIN_ENDPOINT") {
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
