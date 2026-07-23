import path from "node:path";
import {
  LocalShellBackend,
  type EditResult,
  type LocalShellBackendOptions,
  type ReadResult,
  type WriteResult,
} from "deepagents";
import { OPEN_WIKI_DIR } from "../constants.js";
import type { OpenWikiOutputMode } from "./types.js";

export const MUTATION_PATH_METADATA_KEY = "openwikiMutationPath";

type OpenWikiBackendOptions = LocalShellBackendOptions & {
  docsOnly?: boolean;
  outputMode?: OpenWikiOutputMode;
};

export class OpenWikiLocalShellBackend extends LocalShellBackend {
  private readonly docsOnly: boolean;
  private readonly outputMode: OpenWikiOutputMode;

  constructor(options: OpenWikiBackendOptions) {
    super(options);
    this.docsOnly = options.docsOnly === true;
    this.outputMode = options.outputMode ?? "repository";
  }

  override async write(
    filePath: string,
    content: string,
  ): Promise<WriteResult> {
    const error = this.getDocsOnlyWriteError(filePath);
    if (error) {
      return { error };
    }

    return markMutation(await super.write(filePath, content), filePath);
  }

  override async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): Promise<EditResult> {
    const error = this.getDocsOnlyWriteError(filePath);
    if (error) {
      return { error };
    }

    return markMutation(
      await super.edit(filePath, oldString, newString, replaceAll),
      filePath,
    );
  }

  override async read(
    filePath: string,
    offset?: number,
    limit?: number,
  ): Promise<ReadResult> {
    const result = await super.read(filePath, offset, limit);

    // Leave errors and empty reads untouched.
    if (result.error !== undefined || result.content === undefined) {
      return result;
    }

    if (isBinaryReadContent(result.content)) {
      const size =
        result.content instanceof Uint8Array
          ? `${result.content.byteLength} bytes`
          : `${result.content.length} chars`;
      return {
        content: `Binary file skipped: ${filePath} (${
          result.mimeType ?? "unknown type"
        }, ${size}). OpenWiki reads text sources only.`,
        mimeType: "text/plain",
      };
    }

    return result;
  }

  private getDocsOnlyWriteError(filePath: string): string | null {
    if (
      !this.docsOnly ||
      this.outputMode === "local-wiki" ||
      isOpenWikiDocsPath(filePath)
    ) {
      return null;
    }

    return `OpenWiki repository init/update runs may only write under /${OPEN_WIKI_DIR}/. Refused path: ${filePath}`;
  }
}

/** Carries a successful mutation's file path into the ToolMessage metadata used by the validator. */
function markMutation<Result extends WriteResult | EditResult>(
  result: Result,
  filePath: string,
): Result {
  if (!result.error) {
    result.metadata = {
      ...result.metadata,
      [MUTATION_PATH_METADATA_KEY]: result.path ?? filePath,
    };
  }
  return result;
}

export function isOpenWikiDocsPath(filePath: string): boolean {
  const slashed = filePath.trim().replace(/\\/gu, "/");
  // Collapse `..`/`.` segments before the prefix check so a path like
  // "/openwiki/../AGENTS.md" cannot escape the openwiki/ confinement.
  const normalized = path.posix.normalize(`/${slashed.replace(/^\/+/u, "")}`);
  const virtualPath = normalized.replace(/^\/+/u, "");

  return (
    virtualPath === OPEN_WIKI_DIR || virtualPath.startsWith(`${OPEN_WIKI_DIR}/`)
  );
}

/**
 * True when a read result's content is binary rather than usable text.
 *
 * OpenWiki documents code and never needs raw bytes, so two cases get
 * collapsed to a placeholder:
 *  1. `Uint8Array` — deepagents returns raw bytes for MIME types it maps as
 *     binary (images, etc.). Serialized downstream as a base64 `document`
 *     block, which the Anthropic Messages API rejects for anything but
 *     `application/pdf` — the original crash (langchain-ai/openwiki#114).
 *  2. A `string` that is actually binary — deepagents now defaults unmapped
 *     extensions to `text/plain` (deepagentsjs#656), so genuine binaries such
 *     as `.sqlite` / `.zip` / `.so` arrive as strings full of raw bytes: no
 *     longer a crash, but useless token noise in the agent's context.
 */
export function isBinaryReadContent(content: string | Uint8Array): boolean {
  if (content instanceof Uint8Array) {
    return true;
  }

  return isBinaryText(content);
}

/**
 * Heuristic binary sniff for string content — a NUL byte, or a high density of
 * control characters and UTF-8 replacement characters, mirroring the test used
 * by grep/git. Only the head of the content is inspected so large text files
 * stay cheap.
 */
function isBinaryText(text: string): boolean {
  if (text.length === 0) {
    return false;
  }

  const sampleLength = Math.min(text.length, 8192);
  let suspiciousCount = 0;

  for (let index = 0; index < sampleLength; index++) {
    const code = text.charCodeAt(index);

    // A NUL byte is definitive: valid UTF-8 text never contains one.
    if (code === 0) {
      return true;
    }

    // Strong binary evidence: C0 control chars other than tab (9), LF (10),
    // FF (12), CR (13), plus the U+FFFD replacement character a lossy UTF-8
    // decode leaves behind for invalid bytes. A binary that deepagents surfaces
    // as text/plain (e.g. a 0xFF-filled firmware image) decodes to a run of
    // U+FFFD before this sniff runs, so counting only C0 controls would miss it.
    if (
      (code < 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13) ||
      code === 0xfffd
    ) {
      suspiciousCount++;
    }
  }

  return suspiciousCount / sampleLength > 0.3;
}
