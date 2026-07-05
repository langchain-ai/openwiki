import { LocalShellBackend, type ReadResult } from "deepagents";

/**
 * LocalShellBackend that never returns raw binary content to the model.
 *
 * The base FilesystemBackend returns the full Uint8Array for any file whose
 * MIME type is not text (for example `__pycache__/*.pyc`, images, sqlite
 * files). Downstream, non-image binary content is serialized as a base64
 * `document` content block, and the Anthropic Messages API only accepts
 * `application/pdf` there — so a single binary read fails the request with
 * a 400 and aborts the entire run:
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

    if (result.content instanceof Uint8Array) {
      return {
        content: `Binary file skipped: ${filePath} (${
          result.mimeType ?? "unknown type"
        }, ${result.content.byteLength} bytes). OpenWiki reads text sources only.`,
        mimeType: "text/plain",
      };
    }

    return result;
  }
}
