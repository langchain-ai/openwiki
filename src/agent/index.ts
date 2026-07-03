import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { ChatAnthropic } from "@langchain/anthropic";
import { ToolMessage } from "@langchain/core/messages";
import type { StructuredTool } from "@langchain/core/tools";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { ChatOpenAI } from "@langchain/openai";
import { ChatOpenRouter } from "@langchain/openrouter";
import {
  createDeepAgent,
  GENERAL_PURPOSE_SUBAGENT,
  getHarnessProfile,
  LocalShellBackend,
  type HarnessProfile,
  type SubAgent,
} from "deepagents";
import { createMiddleware } from "langchain";
import { loadOpenWikiEnv, openWikiEnvDir } from "../env.js";
import { createSystemPrompt, createUserPrompt } from "./prompt.js";
import type {
  OpenWikiCommand,
  OpenWikiRunEvent,
  OpenWikiRunOptions,
  OpenWikiRunResult,
} from "./types.js";
import {
  ANTHROPIC_API_KEY_ENV_KEY,
  BASETEN_API_KEY_ENV_KEY,
  FIREWORKS_API_KEY_ENV_KEY,
  getDefaultModelId,
  getProviderApiKeyEnvKey,
  getProviderConfig,
  getProviderLabel,
  isValidModelId,
  normalizeModelId,
  OPENAI_API_KEY_ENV_KEY,
  OPENROUTER_API_KEY_ENV_KEY,
  OPENROUTER_BASE_URL,
  OPENROUTER_FALLBACK_MODEL_IDS,
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

/**
 * deepagents' read_file tool returns binary files as one of `{ type: "file" }`,
 * `{ type: "image" }`, `{ type: "audio" }`, or `{ type: "video" }` content
 * blocks (based on the file's extension-derived mimeType), each carrying that
 * mimeType and base64 data. Anthropic's API only accepts a narrow subset of
 * these: "file"/document blocks must be application/pdf, "image" blocks must
 * be one of a handful of raster formats, and it has no audio or video content
 * block type at all. Anything outside that subset — including extensionless
 * files (Dockerfile, LICENSE, CHANGELOG, ...), which deepagents' MIME lookup
 * defaults to application/octet-stream — gets rejected by the API and crashes
 * the whole run. Swap those blocks for a text placeholder instead of sending
 * them to the model.
 */
const sanitizeBinaryFileToolResultsMiddleware = createMiddleware({
  name: "SanitizeBinaryFileToolResults",
  wrapToolCall: async (request, handler) => {
    const result = await handler(request);

    if (!(result instanceof ToolMessage) || !Array.isArray(result.content)) {
      return result;
    }

    result.content = result.content.map((block) =>
      isUnsupportedMultimodalBlock(block)
        ? {
            type: "text",
            text: `[OpenWiki] Skipped ${block.type} content (mime type "${block.mimeType}"): unsupported for inline preview by this model.`,
          }
        : block,
    );

    return result;
  },
});

/** Raster image formats Anthropic's "image" content blocks accept (e.g. not HEIC/HEIF). */
const ANTHROPIC_SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function isUnsupportedMultimodalBlock(
  block: unknown,
): block is { type: string; mimeType: string } {
  if (typeof block !== "object" || block === null) {
    return false;
  }

  const type = (block as { type?: unknown }).type;
  const mimeType = (block as { mimeType?: unknown }).mimeType;

  if (typeof mimeType !== "string") {
    return false;
  }

  if (type === "file") {
    return mimeType !== "application/pdf";
  }

  if (type === "image") {
    return !ANTHROPIC_SUPPORTED_IMAGE_MIME_TYPES.has(mimeType);
  }

  // Anthropic's Messages API has no audio or video content block type.
  return type === "audio" || type === "video";
}

/**
 * deepagents auto-adds the general-purpose subagent using a harness profile
 * resolved for the configured model (e.g. registered prompt suffixes for
 * specific Anthropic/OpenAI models), and that subagent doesn't inherit the
 * main agent's `middleware`. To attach our sanitizer to it we have to
 * redeclare it ourselves (deepagents' documented pattern for customizing the
 * GP subagent), which means reproducing that same profile-aware default
 * instead of hardcoding the bare `GENERAL_PURPOSE_SUBAGENT` — otherwise we'd
 * silently drop any model-specific prompt tuning for other users' models.
 *
 * `tools` should be the same array passed to the main agent's `createDeepAgent`
 * call: deepagents' own auto-add path threads the main agent's tools through to
 * the GP subagent, but once we redeclare the subagent ourselves its `tools`
 * field is locked in as-is (no fallback to the main agent's tools), so we have
 * to pass them through explicitly too. (There's no equivalent `skills` wiring
 * yet since the main agent doesn't set `skills` either — if it ever does, that
 * needs to be threaded through here the same way.)
 *
 * Returns `null` when the resolved profile explicitly disables the GP
 * subagent, matching deepagents' own auto-add condition.
 */
function createGeneralPurposeSubagentWithSanitizer(
  provider: OpenWikiProvider,
  modelId: string,
  tools: StructuredTool[],
): SubAgent | null {
  const harnessProfile = resolveOpenWikiHarnessProfile(provider, modelId);
  const generalPurposeConfig = harnessProfile?.generalPurposeSubagent;

  if (generalPurposeConfig?.enabled === false) {
    return null;
  }

  return {
    ...GENERAL_PURPOSE_SUBAGENT,
    description:
      generalPurposeConfig?.description ?? GENERAL_PURPOSE_SUBAGENT.description,
    systemPrompt:
      generalPurposeConfig?.systemPrompt ??
      applyHarnessProfilePrompt(harnessProfile, GENERAL_PURPOSE_SUBAGENT.systemPrompt),
    tools,
    middleware: [sanitizeBinaryFileToolResultsMiddleware],
  };
}

/**
 * Maps an OpenWiki provider to the model-class-based provider hint deepagents'
 * internal harness-profile resolution uses. deepagents only recognizes a
 * model instance's provider by class name (ChatAnthropic -> "anthropic",
 * ChatOpenAI -> "openai", ChatGoogleGenerativeAI -> "google"). `createModel`
 * below instantiates ChatOpenAI for openai/baseten/fireworks alike, and
 * ChatOpenRouter (unrecognized by deepagents) for openrouter — so those must
 * map the same way here, or profile lookups silently diverge from what
 * deepagents itself resolves for the main agent.
 */
function toHarnessProfileProviderHint(
  provider: OpenWikiProvider,
): string | undefined {
  if (provider === "anthropic") {
    return "anthropic";
  }

  if (provider === "openrouter") {
    return undefined;
  }

  return "openai";
}

/** Mirrors deepagents' internal (unexported) `resolveHarnessProfile` resolution order. */
function resolveOpenWikiHarnessProfile(
  provider: OpenWikiProvider,
  modelId: string,
): HarnessProfile | undefined {
  const providerHint = toHarnessProfileProviderHint(provider);

  if (providerHint && !modelId.includes(":")) {
    const profile = getHarnessProfile(`${providerHint}:${modelId}`);

    if (profile) {
      return profile;
    }
  }

  if (modelId.includes(":")) {
    const profile = getHarnessProfile(modelId);

    if (profile) {
      return profile;
    }
  }

  return providerHint ? getHarnessProfile(providerHint) : undefined;
}

/** Mirrors deepagents' internal (unexported) prompt-assembly rule for a resolved harness profile. */
function applyHarnessProfilePrompt(
  profile: HarnessProfile | undefined,
  basePrompt: string,
): string {
  const prompt = profile?.baseSystemPrompt ?? basePrompt;

  return profile?.systemPromptSuffix !== undefined
    ? `${prompt}\n\n${profile.systemPromptSuffix}`
    : prompt;
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
  const mainAgentTools: StructuredTool[] = [];
  const generalPurposeSubagent = createGeneralPurposeSubagentWithSanitizer(
    provider,
    modelId,
    mainAgentTools,
  );
  const agent = createDeepAgent({
    model,
    tools: mainAgentTools,
    checkpointer,
    backend: new LocalShellBackend({
      maxOutputBytes: 100_000,
      rootDir: cwd,
      timeout: 120,
      virtualMode: true,
    }),
    systemPrompt: createSystemPrompt(command),
    middleware: [sanitizeBinaryFileToolResultsMiddleware],
    subagents: generalPurposeSubagent ? [generalPurposeSubagent] : [],
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

async function createModel(provider: OpenWikiProvider, modelId: string) {
  if (provider === "anthropic") {
    return new ChatAnthropic(modelId, {
      apiKey: process.env[getProviderApiKeyEnvKey(provider)],
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

  const providerConfig = getProviderConfig(provider);

  return new ChatOpenAI({
    apiKey: process.env[getProviderApiKeyEnvKey(provider)],
    configuration: providerConfig.baseURL
      ? {
          baseURL: providerConfig.baseURL,
        }
      : undefined,
    model: modelId,
  });
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

  return messages.reduce((total, message) => {
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
    return content.reduce(
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

function sanitizeOpenRouterResponseBody(body: string): string {
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
