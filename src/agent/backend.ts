import { Buffer } from "node:buffer";
import { LocalShellBackend, type ReadResult } from "deepagents";

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/javascript",
  "application/typescript",
  "application/xml",
  "image/svg+xml",
]);

const BINARY_MIME_TYPES = new Set([
  "application/gzip",
  "application/octet-stream",
  "application/pdf",
  "application/wasm",
  "application/x-7z-compressed",
  "application/x-gzip",
  "application/x-rar-compressed",
  "application/x-sqlite3",
  "application/x-tar",
  "application/zip",
]);

const BINARY_MIME_PREFIXES = ["audio/", "font/", "image/", "video/"];

/**
 * LocalShellBackend that never returns raw binary content to the model.
 *
 * The base FilesystemBackend returns the full Uint8Array for any file whose
 * MIME type is not text (for example `__pycache__/*.pyc`, images, sqlite
 * files). Downstream, unsupported binary or multimodal content blocks can be
 * rejected by providers such as Anthropic or OpenAI, so a single binary read
 * can abort the entire run:
 * https://github.com/langchain-ai/openwiki/issues/114
 *
 * OpenWiki documents codebases, which is a text task; it never needs raw
 * binary bytes. Replacing binary reads with a short text placeholder lets
 * the agent note the file and move on instead of crashing the run.
 */
export class OpenWikiShellBackend extends LocalShellBackend {
  override async read(
    filePath: string,
    offset?: number,
    limit?: number,
  ): Promise<ReadResult> {
    const result = await super.read(filePath, offset, limit);
    const binaryByteLength = getBinaryByteLength(result.content);

    if (binaryByteLength !== null) {
      return {
        content: `Binary file skipped: ${filePath} (${
          result.mimeType ?? "unknown type"
        }, ${binaryByteLength} bytes). OpenWiki reads text sources only.`,
        mimeType: "text/plain",
      };
    }

    if (
      typeof result.content === "string" &&
      isClearlyBinaryMimeType(result.mimeType)
    ) {
      return {
        content: `Binary file skipped: ${filePath} (${
          result.mimeType ?? "unknown type"
        }, ${Buffer.byteLength(result.content)} bytes). OpenWiki reads text sources only.`,
        mimeType: "text/plain",
      };
    }

    return result;
  }
}

function getBinaryByteLength(content: unknown): number | null {
  // In Node, Buffer extends Uint8Array, so this catches Buffers too.
  if (content instanceof Uint8Array) {
    return content.byteLength;
  }

  if (content instanceof ArrayBuffer) {
    return content.byteLength;
  }

  if (ArrayBuffer.isView(content)) {
    return content.byteLength;
  }

  return null;
}

function isClearlyBinaryMimeType(mimeType: string | undefined): boolean {
  const normalized = normalizeMimeType(mimeType);

  if (!normalized || isTextMimeType(normalized)) {
    return false;
  }

  return (
    BINARY_MIME_TYPES.has(normalized) ||
    BINARY_MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

function isTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    TEXT_MIME_TYPES.has(mimeType) ||
    mimeType.endsWith("+json") ||
    mimeType.endsWith("+xml")
  );
}

function normalizeMimeType(mimeType: string | undefined): string | null {
  return mimeType?.split(";", 1)[0]?.trim().toLowerCase() || null;
}
