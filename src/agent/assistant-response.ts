import {
  AIMessage,
  AIMessageChunk,
  ChatMessage,
  ChatMessageChunk,
  collapseToolCallChunks,
  defaultToolCallParser,
  type InvalidToolCall,
  type ToolCall,
  type ToolCallChunk,
} from "@langchain/core/messages";
import { createMiddleware } from "langchain";

/**
 * Normalizes provider-streaming aggregates that are assistant output but were
 * typed as generic chat messages because the first OpenAI-compatible SSE delta
 * arrived without `role:"assistant"` (for example reasoning-only first deltas).
 *
 * LangChain validates each wrapModelCall response before the agent node can
 * continue. Coerce only at the agent middleware boundary so provider transport
 * handling stays owned by the model client.
 *
 * @param response - Model response returned through wrapModelCall.
 * @returns An AIMessage for assistant-like generic messages, else `response`.
 */
export function coerceAssistantModelResponse(response: AIMessage): AIMessage {
  const candidate: unknown = response;

  if (AIMessage.isInstance(candidate)) {
    return candidate;
  }

  if (
    ChatMessageChunk.isInstance(candidate) &&
    isGenericAssistantModelResponse(candidate)
  ) {
    const rawToolCalls = getOpenAiRawToolCalls(candidate.additional_kwargs);
    const toolCallFields =
      rawToolCalls === null
        ? {}
        : collapseToolCallChunks(rawToolCalls.map(toToolCallChunk));

    return new AIMessageChunk({
      content: candidate.content,
      additional_kwargs: candidate.additional_kwargs,
      response_metadata: candidate.response_metadata,
      id: candidate.id,
      name: candidate.name,
      ...toolCallFields,
    });
  }

  if (
    ChatMessage.isInstance(candidate) &&
    isGenericAssistantModelResponse(candidate)
  ) {
    const rawToolCalls = getOpenAiRawToolCalls(candidate.additional_kwargs);
    const toolCallFields =
      rawToolCalls === null ? {} : parseRawOpenAiToolCalls(rawToolCalls);

    return new AIMessage({
      content: candidate.content,
      additional_kwargs: candidate.additional_kwargs,
      response_metadata: candidate.response_metadata,
      id: candidate.id,
      name: candidate.name,
      ...toolCallFields,
    });
  }

  return response;
}

/**
 * Applies {@link coerceAssistantModelResponse} to every model call of an
 * agent. Listed after DeepAgents' built-in middleware, so it wraps the model
 * call directly and runs before any outer middleware validates the response.
 */
export const ASSISTANT_RESPONSE_MIDDLEWARE = createMiddleware({
  name: "OpenWikiAssistantResponse",
  wrapModelCall: async (request, handler) =>
    coerceAssistantModelResponse(await handler(request)),
});

function isGenericAssistantModelResponse(response: { role?: string }): boolean {
  return response.role === undefined || response.role === "assistant";
}

function getOpenAiRawToolCalls(
  additionalKwargs: Record<string, unknown> | undefined,
): Record<string, unknown>[] | null {
  const rawToolCalls = additionalKwargs?.tool_calls;

  if (!Array.isArray(rawToolCalls)) {
    return null;
  }

  return rawToolCalls.filter(isRecord);
}

function parseRawOpenAiToolCalls(rawToolCalls: Record<string, unknown>[]): {
  invalid_tool_calls: InvalidToolCall[];
  tool_calls: ToolCall[];
} {
  const [toolCalls, invalidToolCalls] = defaultToolCallParser(rawToolCalls);

  return {
    invalid_tool_calls: invalidToolCalls,
    tool_calls: toolCalls,
  };
}

function toToolCallChunk(rawToolCall: Record<string, unknown>): ToolCallChunk {
  const rawFunction = rawToolCall.function;
  const functionFields = isRecord(rawFunction) ? rawFunction : {};

  return {
    id: typeof rawToolCall.id === "string" ? rawToolCall.id : undefined,
    index:
      typeof rawToolCall.index === "number" ? rawToolCall.index : undefined,
    name:
      typeof functionFields.name === "string" ? functionFields.name : undefined,
    args:
      typeof functionFields.arguments === "string"
        ? functionFields.arguments
        : undefined,
    type: "tool_call_chunk",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
