import { LocalShellBackend, type ReadResult } from "deepagents";

/**
 * A {@link LocalShellBackend} that recognizes plain-text files regardless of
 * their extension.
 *
 * The base backend decides text-vs-binary purely from the file extension, so
 * text files with unmapped extensions (terraform.tfvars, .tf, .hcl, .lock,
 * .conf, extensionless configs, ...) come back as binary `Uint8Array` content.
 * The read_file tool then wraps them in a base64 block the model cannot read
 * (and that the Anthropic API rejects outright). When the base class returns
 * binary content, this subclass sniffs the bytes and, if they are valid UTF-8
 * without NUL bytes, returns them as text with the same offset/limit line
 * semantics as the base class's text path.
 */
export class TextSniffingLocalShellBackend extends LocalShellBackend {
  override async read(
    filePath: string,
    offset = 0,
    limit = 500,
  ): Promise<ReadResult> {
    const result = await super.read(filePath, offset, limit);

    if (result.error !== undefined || typeof result.content === "string") {
      return result;
    }

    const text =
      result.content === undefined ? null : decodeUtf8Text(result.content);

    if (text === null) {
      return result;
    }

    return {
      content: sliceLines(text, offset, limit),
      mimeType: "text/plain",
    };
  }
}

/**
 * Decodes bytes as UTF-8 text, returning `null` for content that is not
 * plain text (invalid UTF-8 sequences, or NUL bytes — which valid text files
 * do not contain but nearly all binary formats do).
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
 * Mirrors the base class's text-path semantics: `offset` is a 0-indexed
 * starting line and `limit` the maximum number of lines returned.
 */
export function sliceLines(
  text: string,
  offset: number,
  limit: number,
): string {
  if (limit === 0) {
    return "";
  }

  return text
    .split("\n")
    .slice(offset, offset + limit)
    .join("\n");
}
