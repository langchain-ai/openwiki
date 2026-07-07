import { LocalShellBackend } from "deepagents";

/**
 * Result shape returned by {@link LocalShellBackend.read}. Derived from the
 * backend method itself so we don't depend on the type being re-exported.
 */
type ReadResult = Awaited<ReturnType<LocalShellBackend["read"]>>;

/**
 * Decode bytes as UTF-8 text, returning `null` when the bytes are not
 * plausibly text — i.e. they contain a NUL byte or are not valid UTF-8. This
 * is the same cheap heuristic Git uses to distinguish text from binary.
 */
export function decodeUtf8Text(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Re-apply the line-window semantics of the native text read path, so a
 * sniffed-text file behaves identically to a natively recognized text file.
 */
function sliceLines(text: string, offset: number, limit: number): ReadResult {
  const lines = text.split("\n");
  if (offset >= lines.length) {
    return {
      error: `Line offset ${offset} exceeds file length (${lines.length} lines)`,
    };
  }
  const endIdx = Math.min(offset + limit, lines.length);
  return {
    content: lines.slice(offset, endIdx).join("\n"),
    mimeType: "text/plain",
  };
}

/**
 * Reinterpret a binary {@link ReadResult} as text when its bytes decode
 * cleanly as UTF-8. Error results and results that are already text (string
 * content) pass through unchanged.
 */
export function reinterpretBinaryAsText(
  result: ReadResult,
  offset: number,
  limit: number,
): ReadResult {
  if (result.error !== undefined || !(result.content instanceof Uint8Array)) {
    return result;
  }
  const text = decodeUtf8Text(result.content);
  if (text === null) {
    return result;
  }
  return sliceLines(text, offset, limit);
}

/**
 * A {@link LocalShellBackend} that treats files with unrecognized extensions
 * as text when their bytes are valid UTF-8.
 *
 * deepagents' `getMimeType()` maps any unknown extension to
 * `application/octet-stream`, which `read_file` then sends to the model as a
 * base64 `document`/`file` content block. On the Anthropic provider that
 * fails hard with `400 ... media_type: Input should be 'application/pdf'`, and
 * on every provider the model never sees the file's real contents. Many common
 * text files trip this: `.properties`, `.scss`, `.tf`, `.tfvars`, `.hcl`,
 * `.lock`, and extension-less files such as `mvnw` or `Dockerfile`.
 *
 * See https://github.com/langchain-ai/openwiki/issues/168 and #134.
 */
export class TextSniffingLocalShellBackend extends LocalShellBackend {
  override async read(
    filePath: string,
    offset = 0,
    limit = 500,
  ): Promise<ReadResult> {
    const result = await super.read(filePath, offset, limit);
    return reinterpretBinaryAsText(result, offset, limit);
  }
}
