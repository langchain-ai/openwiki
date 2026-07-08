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

// Files larger than this are truncated when decoded to text, so a huge
// extensionless text file can't blow up the prompt.
const MAX_DECODED_TEXT_BYTES = 256 * 1024;

/**
 * The Anthropic Messages API only accepts a base64 `document` block when its
 * media type is `application/pdf`, and only accepts JPEG/PNG/GIF/WebP images.
 * The deep agent's `read_file` tool returns any non-text file (compiled
 * bytecode, archives, extensionless files, unsupported images, audio, video)
 * as a base64 `file`/`image`/`audio`/`video` block with the file's real MIME
 * type, so a single read of such a file fails the whole run with a 400
 * (`document.source.base64.media_type: Input should be 'application/pdf'`).
 *
 * Many of those `file` blocks are really plain text the tool just couldn't
 * classify (`.gitignore`, `Dockerfile`, `LICENSE`, lock files, …). This
 * middleware decodes such blocks back to their text contents so the agent can
 * actually use them, and only falls back to a short placeholder for genuine
 * binary data (or unsupported image/audio/video) that the API would reject.
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
    if (!isBlockUnsupportedByAnthropic(block)) {
      return block;
    }

    changed = true;

    // Prefer the file's real text contents when the bytes decode cleanly;
    // otherwise tell the agent it's unreadable binary.
    const decoded = decodeTextBlock(block);

    return {
      type: "text" as const,
      text: decoded ?? describeOmittedBlock(block),
    };
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

/**
 * Decodes a base64 `file` block back to text when its bytes are genuinely
 * textual, returning `null` for binary data (and for non-`file` blocks such
 * as images/audio/video, which are never text). Detection rejects any NUL
 * byte or invalid UTF-8, which reliably separates text files from binaries.
 */
function decodeTextBlock(block: unknown): string | null {
  const { type, mimeType, data } = block as MultimodalContentBlock;

  if (type !== "file" || typeof data !== "string") {
    return null;
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(data, "base64");
  } catch {
    return null;
  }

  if (bytes.length === 0 || bytes.includes(0)) {
    return null;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }

  if (bytes.length <= MAX_DECODED_TEXT_BYTES) {
    return text;
  }

  // Truncate by character count (not bytes) to avoid splitting a code point.
  const mime = typeof mimeType === "string" ? mimeType : "unknown type";

  return (
    `${text.slice(0, MAX_DECODED_TEXT_BYTES)}\n\n[file content truncated: ` +
    `${mime}, ${bytes.length} bytes total.]`
  );
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
