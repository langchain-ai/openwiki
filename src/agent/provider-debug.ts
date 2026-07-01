import { OPENROUTER_BASE_URL } from "../constants.js";

export const PROVIDER_DEBUG_PROPERTY = "providerDebug";
export const OPENROUTER_DEBUG_PROPERTY = "openRouterDebug";
const PROVIDER_DEBUG_BODY_LIMIT = 8_000;

export type ProviderDebugOptions = {
  onDebug?: (message: string) => void;
};

export type ProviderFetchCapture = {
  clearLastFailure: () => void;
  getLastFailure: () => ProviderFetchFailure | null;
  restore: () => void;
};

export type ProviderFetchFailure = {
  fetchError?: string;
  request: ProviderRequestSummary;
  requestId?: number;
  response?: ProviderResponseSummary;
};

export type ProviderRequestSummary = {
  apiKind: string;
  bodyBytes?: number;
  messageChars?: number;
  messageContentIssues: string[];
  messageCount?: number;
  messageSummaries: ProviderMessageSummary[];
  method: string;
  model?: string;
  stream?: boolean;
  toolCount?: number;
  toolNames?: string[];
  url: string;
};

export type ProviderMessageSummary = {
  contentShape: string;
  contentTypes: string[];
  index: number;
  name?: string;
  role: string;
  toolArgsPreview?: string;
  toolCallId?: string;
  toolName?: string;
};

type ProviderResponseSummary = {
  bodyPreview: string;
  headers: Record<string, string>;
  status: number;
  statusText: string;
};

export function installProviderDebugFetch(
  options: ProviderDebugOptions = {},
): ProviderFetchCapture {
  const originalFetch = globalThis.fetch;
  let lastFailure: ProviderFetchFailure | null = null;
  let requestCounter = 0;

  globalThis.fetch = (async (input, init) => {
    if (!isProviderLlmFetchInput(input)) {
      return originalFetch(input, init);
    }

    requestCounter += 1;
    const requestId = requestCounter;
    const request = summarizeProviderRequest(input, init);

    emitProviderDebug(
      options,
      `provider.http.request #${requestId} ${formatProviderRequestSummary(request)}`,
    );

    for (const issue of request.messageContentIssues) {
      emitProviderDebug(
        options,
        `provider.http.request #${requestId} contentIssue ${issue}`,
      );
    }

    try {
      const response = await originalFetch(input, init);

      if (!response.ok) {
        lastFailure = {
          request,
          requestId,
          response: {
            bodyPreview: await readResponseBodyPreview(response),
            headers: getSafeResponseHeaders(response.headers),
            status: response.status,
            statusText: response.statusText,
          },
        };
        emitProviderDebug(
          options,
          `provider.http.response #${requestId} status=${response.status} statusText=${JSON.stringify(response.statusText)}`,
        );
        emitProviderDebug(
          options,
          `provider.http.response #${requestId} bodyPreview=${JSON.stringify(lastFailure.response?.bodyPreview)}`,
        );
      } else {
        emitProviderDebug(
          options,
          `provider.http.response #${requestId} status=${response.status}`,
        );
      }

      return response;
    } catch (error) {
      lastFailure = {
        fetchError: error instanceof Error ? error.message : String(error),
        request,
        requestId,
      };
      emitProviderDebug(
        options,
        `provider.http.error #${requestId} ${lastFailure.fetchError}`,
      );
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

export function attachProviderDebugInfo(
  error: unknown,
  failure: ProviderFetchFailure | null,
): void {
  if (!failure) {
    return;
  }

  if (isRecord(error)) {
    error[PROVIDER_DEBUG_PROPERTY] = failure;
    error[OPENROUTER_DEBUG_PROPERTY] = failure;
    return;
  }

  if (error instanceof Error) {
    Object.defineProperty(error, PROVIDER_DEBUG_PROPERTY, {
      configurable: true,
      enumerable: false,
      value: failure,
    });
    Object.defineProperty(error, OPENROUTER_DEBUG_PROPERTY, {
      configurable: true,
      enumerable: false,
      value: failure,
    });
  }
}

export function hasAttachedProviderDebug(error: unknown): boolean {
  if (!isRecord(error) && !(error instanceof Error)) {
    return false;
  }

  return (
    (error as Record<string, unknown>).providerDebug !== undefined ||
    (error as Record<string, unknown>).openRouterDebug !== undefined
  );
}

export function isProviderLlmFetchInput(
  input: Parameters<typeof fetch>[0],
): boolean {
  const url = getFetchInputUrl(input);

  if (url === null) {
    return false;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return false;
  }

  const pathname = parsedUrl.pathname;
  const hostname = parsedUrl.hostname;
  const isChatOrResponsesPath =
    pathname.includes("/chat/completions") || pathname.includes("/responses");

  if (isChatOrResponsesPath) {
    let openRouterHostname: string | null = null;
    try {
      openRouterHostname = new URL(OPENROUTER_BASE_URL).hostname;
    } catch {
      openRouterHostname = null;
    }

    if (
      (openRouterHostname !== null && hostname === openRouterHostname) ||
      (openRouterHostname === null && url.startsWith(OPENROUTER_BASE_URL))
    ) {
      return true;
    }

    if (
      hostname === "api.openai.com" ||
      hostname === "gateway.smith.langchain.com" ||
      hostname === "smith.langchain.com"
    ) {
      return true;
    }

    if (
      hostname === "inference.baseten.co" ||
      hostname === "api.fireworks.ai"
    ) {
      return true;
    }
  }

  if (hostname === "api.anthropic.com") {
    return true;
  }

  return false;
}

export function summarizeProviderRequest(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): ProviderRequestSummary {
  const url = getFetchInputUrl(input) ?? "unknown";
  const body = typeof init?.body === "string" ? init.body : null;
  const parsedBody = parseJsonRecord(body);
  const toolNames = getProviderToolNames(parsedBody?.tools);
  const messageAnalysis = analyzeProviderMessages(
    parsedBody?.messages ?? parsedBody?.input,
  );

  return {
    apiKind: detectProviderApiKind(url),
    bodyBytes: body === null ? undefined : Buffer.byteLength(body, "utf8"),
    messageChars: messageAnalysis.totalChars,
    messageContentIssues: messageAnalysis.issues,
    messageCount: messageAnalysis.count,
    messageSummaries: messageAnalysis.summaries,
    method: init?.method ?? "GET",
    model: typeof parsedBody?.model === "string" ? parsedBody.model : undefined,
    stream:
      typeof parsedBody?.stream === "boolean" ? parsedBody.stream : undefined,
    toolCount: toolNames.length,
    toolNames: toolNames.slice(0, 20),
    url: formatProviderDebugUrl(url),
  };
}

export function analyzeProviderMessages(messages: unknown): {
  count: number;
  issues: string[];
  summaries: ProviderMessageSummary[];
  totalChars: number;
} {
  if (!Array.isArray(messages)) {
    return { count: 0, issues: [], summaries: [], totalChars: 0 };
  }

  const toolCallNames = collectToolCallNames(messages);
  const toolCallArgs = collectToolCallArgs(messages);
  const issues: string[] = [];
  const summaries: ProviderMessageSummary[] = [];
  let totalChars = 0;

  messages.forEach((message, index) => {
    if (!isRecord(message)) {
      summaries.push({
        index,
        role: "unknown",
        contentShape: "non-object",
        contentTypes: [],
      });
      return;
    }

    const role =
      typeof message.role === "string"
        ? message.role
        : typeof message.type === "string"
          ? message.type
          : "unknown";
    const content = message.content;
    const toolCallId =
      typeof message.tool_call_id === "string"
        ? message.tool_call_id
        : undefined;
    const analysis = analyzeMessageContent(content);
    totalChars += analysis.chars;

    summaries.push({
      index,
      role,
      contentShape: analysis.shape,
      contentTypes: analysis.types,
      ...(toolCallId ? { toolCallId } : {}),
      ...(toolCallId && toolCallNames[toolCallId]
        ? { toolName: toolCallNames[toolCallId] }
        : {}),
      ...(toolCallId && toolCallArgs[toolCallId]
        ? {
            toolArgsPreview: truncateDiagnosticPreview(
              toolCallArgs[toolCallId],
            ),
          }
        : {}),
      ...(typeof message.name === "string" ? { name: message.name } : {}),
    });

    for (const blockType of analysis.types) {
      if (blockType === "file") {
        const toolLabel =
          toolCallId && toolCallNames[toolCallId]
            ? ` toolName=${toolCallNames[toolCallId]}`
            : "";
        issues.push(
          `messages[${index}] role=${role}${toolLabel} has content block type=file (unsupported on chat-completions for many models)`,
        );
      }
    }

    for (const issue of analysis.issues) {
      issues.push(`messages[${index}] role=${role} ${issue}`);
    }
  });

  return {
    count: messages.length,
    issues,
    summaries,
    totalChars,
  };
}

export function analyzeMessageContent(content: unknown): {
  chars: number;
  issues: string[];
  shape: string;
  types: string[];
} {
  if (typeof content === "string") {
    return {
      chars: content.length,
      issues: [],
      shape: "string",
      types: ["text"],
    };
  }

  if (Array.isArray(content)) {
    const types: string[] = [];
    const issues: string[] = [];
    let chars = 0;

    for (const [blockIndex, block] of content.entries()) {
      if (typeof block === "string") {
        types.push("text");
        chars += block.length;
        continue;
      }

      if (!isRecord(block)) {
        types.push(typeof block);
        issues.push(`content[${blockIndex}] unexpected type=${typeof block}`);
        continue;
      }

      const blockType = typeof block.type === "string" ? block.type : "unknown";
      types.push(blockType);

      if (blockType === "text" && typeof block.text === "string") {
        chars += block.text.length;
      } else if (typeof block.content === "string") {
        chars += block.content.length;
      }

      if (blockType === "file") {
        const fileKeys = isRecord(block.file) ? Object.keys(block.file) : [];
        issues.push(
          `content[${blockIndex}] type=file fileKeys=${fileKeys.join(",") || "none"}`,
        );
      }
    }

    return {
      chars,
      issues,
      shape: "array",
      types: Array.from(new Set(types)),
    };
  }

  if (isRecord(content)) {
    const blockType =
      typeof content.type === "string" ? content.type : "object";

    return {
      chars: countMessageContentChars(content),
      issues:
        blockType === "file" ? ["top-level content object has type=file"] : [],
      shape: "object",
      types: [blockType],
    };
  }

  return {
    chars: 0,
    issues:
      content === null || content === undefined
        ? []
        : [`unexpected content type=${typeof content}`],
    shape: typeof content,
    types: [],
  };
}

function emitProviderDebug(
  options: ProviderDebugOptions,
  message: string,
): void {
  options.onDebug?.(message);
}

function formatProviderRequestSummary(request: ProviderRequestSummary): string {
  const parts = [
    `url=${JSON.stringify(request.url)}`,
    `method=${request.method}`,
  ];

  if (request.model) {
    parts.push(`model=${JSON.stringify(request.model)}`);
  }

  if (request.apiKind) {
    parts.push(`apiKind=${request.apiKind}`);
  }

  if (request.messageCount !== undefined) {
    parts.push(`messages=${request.messageCount}`);
  }

  if (request.messageChars !== undefined) {
    parts.push(`messageChars=${request.messageChars}`);
  }

  if (request.toolCount !== undefined) {
    parts.push(`tools=${request.toolCount}`);
  }

  if (request.stream !== undefined) {
    parts.push(`stream=${request.stream}`);
  }

  if (request.messageSummaries.length > 0) {
    parts.push(`messageTypes=${JSON.stringify(request.messageSummaries)}`);
  }

  return parts.join(" ");
}

function detectProviderApiKind(url: string): string {
  if (url.includes("/responses")) {
    return "openai-responses";
  }

  if (url.includes("/chat/completions")) {
    return "chat-completions";
  }

  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.hostname.toLowerCase() === "api.anthropic.com") {
      return "anthropic-messages";
    }
  } catch {
    // Ignore invalid URLs and fall through to unknown.
  }

  return "unknown";
}

function collectToolCallNames(messages: unknown[]): Record<string, string> {
  const toolCallNames: Record<string, string> = {};

  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.tool_calls)) {
      continue;
    }

    for (const toolCall of message.tool_calls) {
      if (!isRecord(toolCall) || typeof toolCall.id !== "string") {
        continue;
      }

      const name =
        isRecord(toolCall.function) &&
        typeof toolCall.function.name === "string"
          ? toolCall.function.name
          : typeof toolCall.name === "string"
            ? toolCall.name
            : undefined;

      if (name) {
        toolCallNames[toolCall.id] = name;
      }
    }
  }

  return toolCallNames;
}

function collectToolCallArgs(messages: unknown[]): Record<string, string> {
  const toolCallArgs: Record<string, string> = {};

  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.tool_calls)) {
      continue;
    }

    for (const toolCall of message.tool_calls) {
      if (!isRecord(toolCall) || typeof toolCall.id !== "string") {
        continue;
      }

      const rawArgs =
        isRecord(toolCall.function) &&
        typeof toolCall.function.arguments === "string"
          ? toolCall.function.arguments
          : typeof toolCall.args === "string"
            ? toolCall.args
            : toolCall.args !== undefined
              ? JSON.stringify(toolCall.args)
              : undefined;

      if (rawArgs !== undefined) {
        toolCallArgs[toolCall.id] = rawArgs;
      }
    }
  }

  return toolCallArgs;
}

function truncateDiagnosticPreview(value: string, maxLength = 200): string {
  const normalized = value.trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function getProviderToolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools
    .map((tool) => {
      if (!isRecord(tool)) {
        return null;
      }

      if (isRecord(tool.function) && typeof tool.function.name === "string") {
        return tool.function.name;
      }

      if (typeof tool.name === "string") {
        return tool.name;
      }

      return null;
    })
    .filter((name): name is string => name !== null);
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
    const sanitizedBody = sanitizeProviderResponseBody(body);

    return sanitizedBody.length <= PROVIDER_DEBUG_BODY_LIMIT
      ? sanitizedBody
      : `${sanitizedBody.slice(0, PROVIDER_DEBUG_BODY_LIMIT - 3)}...`;
  } catch (error) {
    return `Unable to read response body: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

function sanitizeProviderResponseBody(body: string): string {
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

function formatProviderDebugUrl(value: string): string {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
