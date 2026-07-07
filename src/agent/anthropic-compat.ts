import { createMiddleware, ToolMessage, type BaseMessage } from "langchain";

const PDF_MIME_TYPE = "application/pdf";

const ANTHROPIC_SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

type MultimodalContentBlock = {
  type?: unknown;
  mimeType?: unknown;
  data?: unknown;
};

/**
 * The Anthropic Messages API only accepts a base64 `document` block when its
 * media type is `application/pdf`, and only accepts JPEG/PNG/GIF/WebP images.
 * The deep agent's `read_file` tool returns any non-text file (compiled
 * bytecode, archives, extensionless files, unsupported images, audio, video)
 * as a base64 `file`/`image`/`audio`/`video` block with the file's real MIME
 * type, so a single read of such a file fails the whole run with a 400
 * (`document.source.base64.media_type: Input should be 'application/pdf'`).
 *
 * This middleware rewrites those unsupported blocks in tool results into a
 * short text placeholder before each Anthropic model call, so the agent is
 * told the file is unreadable binary data instead of the run crashing.
 */
export const anthropicMultimodalCompatMiddleware = createMiddleware({
  name: "AnthropicMultimodalCompat",
  wrapModelCall: (request, handler) =>
    handler({
      ...request,
      messages: sanitizeMessagesForAnthropic(request.messages),
    }),
});

export function sanitizeMessagesForAnthropic(
  messages: BaseMessage[],
): BaseMessage[] {
  return messages.map((message) => sanitizeMessage(message));
}

function sanitizeMessage(message: BaseMessage): BaseMessage {
  // Unsupported binary blocks only enter the conversation through tool
  // results (the read_file tool); other message types are left untouched.
  if (!(message instanceof ToolMessage) || !Array.isArray(message.content)) {
    return message;
  }

  let changed = false;
  const content = message.content.map((block) => {
    if (isBlockUnsupportedByAnthropic(block)) {
      changed = true;

      return {
        type: "text" as const,
        text: describeOmittedBlock(block),
      };
    }

    return block;
  });

  if (!changed) {
    return message;
  }

  return new ToolMessage({
    additional_kwargs: message.additional_kwargs,
    artifact: message.artifact as never,
    content,
    id: message.id,
    name: message.name,
    response_metadata: message.response_metadata,
    status: message.status,
    tool_call_id: message.tool_call_id,
  });
}

function isBlockUnsupportedByAnthropic(block: unknown): boolean {
  if (typeof block !== "object" || block === null) {
    return false;
  }

  const { type, mimeType } = block as MultimodalContentBlock;

  if (type === "audio" || type === "video") {
    return true;
  }

  if (type === "file") {
    return mimeType !== PDF_MIME_TYPE;
  }

  if (type === "image") {
    return (
      typeof mimeType === "string" &&
      !ANTHROPIC_SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)
    );
  }

  return false;
}

function describeOmittedBlock(block: unknown): string {
  const { type, mimeType, data } = block as MultimodalContentBlock;
  const kind = typeof type === "string" ? type : "binary";
  const mime = typeof mimeType === "string" ? mimeType : "unknown type";
  const approximateBytes =
    typeof data === "string" ? Math.ceil((data.length * 3) / 4) : null;
  const size = approximateBytes === null ? "" : `, ~${approximateBytes} bytes`;

  return (
    `[${kind} content omitted: ${mime}${size}. This file is binary data the ` +
    "Anthropic API cannot accept; treat it as unreadable and do not try to " +
    "read it again.]"
  );
}
