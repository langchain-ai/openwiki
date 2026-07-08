import {
  LocalShellBackend,
  type LocalShellBackendOptions,
  type ReadRawResult,
  type ReadResult,
} from "deepagents";

const UNKNOWN_BINARY_MIME_TYPE = "application/octet-stream";
const OPENWIKI_TEXT_MIME_TYPE = "text/plain";

export class OpenWikiLocalShellBackend extends LocalShellBackend {
  constructor(options: LocalShellBackendOptions = {}) {
    super(options);
  }

  async read(filePath: string, offset = 0, limit = 500): Promise<ReadResult> {
    const result = await super.read(filePath, offset, limit);

    if (!isUnknownBinaryResult(result)) {
      return result;
    }

    const text = decodeTextContent(result.content);

    if (text === null) {
      return result;
    }

    return {
      content: sliceLines(text, offset, limit),
      mimeType: OPENWIKI_TEXT_MIME_TYPE,
    };
  }

  async readRaw(filePath: string): Promise<ReadRawResult> {
    const result = await super.readRaw(filePath);

    if (!isUnknownBinaryRawResult(result)) {
      return result;
    }

    const text = decodeTextContent(result.data.content);

    if (text === null) {
      return result;
    }

    return {
      data: {
        ...result.data,
        content: text,
        mimeType: OPENWIKI_TEXT_MIME_TYPE,
      },
    };
  }
}

function isUnknownBinaryResult(
  result: ReadResult,
): result is ReadResult & { content: Uint8Array; mimeType: string } {
  return (
    result.error === undefined &&
    result.mimeType === UNKNOWN_BINARY_MIME_TYPE &&
    result.content instanceof Uint8Array
  );
}

function isUnknownBinaryRawResult(
  result: ReadRawResult,
): result is ReadRawResult & {
  data: NonNullable<ReadRawResult["data"]> & {
    content: Uint8Array;
    mimeType: string;
  };
} {
  return (
    result.error === undefined &&
    result.data !== undefined &&
    "mimeType" in result.data &&
    result.data.mimeType === UNKNOWN_BINARY_MIME_TYPE &&
    result.data.content instanceof Uint8Array
  );
}

function decodeTextContent(content: Uint8Array): string | null {
  if (content.includes(0)) {
    return null;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

function sliceLines(content: string, offset: number, limit: number): string {
  const lines = content.split("\n");
  const startIdx = offset;
  const endIdx = Math.min(startIdx + limit, lines.length);

  return lines.slice(startIdx, endIdx).join("\n");
}
