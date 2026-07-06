import { LocalShellBackend, type ReadResult } from "deepagents";

/**
 * deepagents' `read_file` tool builds an `image`/`audio`/`video`/`file` standard
 * content block for any file its backend reports as non-text. That `type: "file"`
 * content part is forwarded by `@langchain/openai` to `/chat/completions`, and
 * OpenAI (plus other OpenAI-compatible providers) reject it with:
 * `Invalid value: 'file'. Supported values are: 'text', 'refusal', 'image_url', and 'input_audio'.`
 *
 * The backend returns a `string` for files it already considers text and a
 * `Uint8Array` for everything else (binaries, media, and any unrecognized or
 * extension-less path such as `LICENSE`/`Dockerfile`, which map to
 * `application/octet-stream`). We only need to handle that second case: decode
 * the bytes as UTF-8 and, when they are genuinely text, hand the real content
 * back as `text/plain` so `read_file` emits a `text` block instead of a `file`
 * block. Only truly binary bytes fall back to a placeholder.
 *
 * Keying off the content shape (string vs. bytes) rather than re-deriving the
 * MIME classification avoids duplicating deepagents' text-type list, and using
 * the decoded bytes rather than the MIME label preserves plain-text files that
 * deepagents mislabels as binary.
 */

// Matches deepagents' own binary read cap; skip decoding anything larger.
const MAX_DECODE_BYTES = 10 * 1024 * 1024;
const PLACEHOLDER_MIME_TYPE = "text/plain";
const NUL = String.fromCharCode(0);

function decodeUtf8Text(bytes: Uint8Array): string | null {
  if (bytes.byteLength > MAX_DECODE_BYTES) {
    return null;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }

  // A NUL byte is valid UTF-8 but is a strong signal of binary data (and of
  // UTF-16/UTF-32 text, which we deliberately treat as binary here).
  return text.includes(NUL) ? null : text;
}

/**
 * Normalize a backend read so it can never yield a non-text content block:
 * genuine text is preserved (decoded when necessary), binary bytes become a
 * short text placeholder, and errors pass through untouched.
 */
export function toTextOnlyReadResult(
  filePath: string,
  result: ReadResult,
): ReadResult {
  if (result.error !== undefined) {
    return result;
  }

  // Already text: deepagents only returns string content for files it treats as
  // text, so `read_file` will emit a text block unchanged.
  if (typeof result.content === "string") {
    return result;
  }

  if (ArrayBuffer.isView(result.content)) {
    const bytes = new Uint8Array(
      result.content.buffer,
      result.content.byteOffset,
      result.content.byteLength,
    );
    const decoded = decodeUtf8Text(bytes);

    if (decoded !== null) {
      return { content: decoded, mimeType: PLACEHOLDER_MIME_TYPE };
    }

    return {
      content: `[OpenWiki skipped a binary file during documentation: ${filePath}]`,
      mimeType: PLACEHOLDER_MIME_TYPE,
    };
  }

  return result;
}

/**
 * Build the deepagents filesystem backend used for documentation runs, wrapping
 * `read` so binary files are surfaced to the model as text placeholders and
 * mislabeled plain-text files are surfaced as their real (decoded) content —
 * never as a multimodal content block.
 */
export function createDocumentationBackend(cwd: string): LocalShellBackend {
  const backend = new LocalShellBackend({
    maxOutputBytes: 100_000,
    rootDir: cwd,
    timeout: 120,
    virtualMode: true,
  });

  const originalRead = backend.read.bind(backend);

  backend.read = async (filePath, offset, limit) =>
    toTextOnlyReadResult(filePath, await originalRead(filePath, offset, limit));

  return backend;
}
