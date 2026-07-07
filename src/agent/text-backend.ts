import { LocalShellBackend } from "deepagents";

type BackendReadResult = Awaited<ReturnType<LocalShellBackend["read"]>>;

/**
 * LocalShellBackend classifies text/binary by MIME type, which can mark
 * extensionless or unmapped text files as binary. This wrapper keeps genuine
 * binary files untouched, but reclassifies valid UTF-8 byte results as text.
 */
export class TextSniffingLocalShellBackend extends LocalShellBackend {
  override async read(
    filePath: string,
    offset = 0,
    limit = 500,
  ): Promise<BackendReadResult> {
    const result = await super.read(filePath, offset, limit);

    return sniffBinaryReadResultAsText(result, offset, limit) ?? result;
  }
}

export function sniffBinaryReadResultAsText<T extends { content?: unknown }>(
  result: T,
  offset = 0,
  limit = 500,
): (T & { content: string; mimeType: "text/plain" }) | null {
  const bytes = getByteContent(result.content);

  if (!bytes) {
    return null;
  }

  const text = decodeUtf8Text(bytes);

  if (text === null || text.includes("\0")) {
    return null;
  }

  return {
    ...result,
    content: applyLineWindow(text, offset, limit),
    mimeType: "text/plain",
  };
}

function getByteContent(content: unknown): Uint8Array | null {
  if (content instanceof Uint8Array) {
    return content;
  }

  if (content instanceof ArrayBuffer) {
    return new Uint8Array(content);
  }

  return null;
}

function decodeUtf8Text(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function applyLineWindow(
  text: string,
  offset = 0,
  limit = 500,
): string {
  const start = Math.max(0, offset);
  const count = Math.max(0, limit);

  return text.split("\n").slice(start, start + count).join("\n");
}
