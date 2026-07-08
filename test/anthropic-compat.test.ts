import { AIMessage, HumanMessage, ToolMessage } from "langchain";
import { describe, expect, test } from "vitest";
import { sanitizeMessagesForAnthropic } from "../src/agent/anthropic-compat.ts";

function toolMessage(content: unknown): ToolMessage {
  return new ToolMessage({
    content: content as ToolMessage["content"],
    tool_call_id: "call_1",
  });
}

const PNG_BASE64 = "iVBORw0KGgo=";

// Decodes to bytes containing a NUL (0x00), i.e. genuine binary data.
const BINARY_BASE64 = Buffer.from([0x89, 0x50, 0x00, 0x1a]).toString("base64");

function textFileBlock(text: string, mimeType = "application/octet-stream") {
  return {
    type: "file",
    mimeType,
    data: Buffer.from(text, "utf-8").toString("base64"),
  };
}

describe("sanitizeMessagesForAnthropic", () => {
  test("replaces binary file blocks with a text placeholder", () => {
    const [sanitized] = sanitizeMessagesForAnthropic([
      toolMessage([
        {
          type: "file",
          mimeType: "application/octet-stream",
          data: BINARY_BASE64,
        },
      ]),
    ]);

    const [block] = sanitized.content as Array<{ type: string; text: string }>;

    expect(block.type).toBe("text");
    expect(block.text).toContain("application/octet-stream");
    expect(block.text).not.toContain(BINARY_BASE64);
  });

  test("decodes text file blocks (e.g. .gitignore) to their contents", () => {
    const contents = "node_modules/\ndist/\n.env\n";
    const [sanitized] = sanitizeMessagesForAnthropic([
      toolMessage([textFileBlock(contents)]),
    ]);

    const [block] = sanitized.content as Array<{ type: string; text: string }>;

    expect(block.type).toBe("text");
    expect(block.text).toBe(contents);
  });

  test("truncates very large text file blocks but keeps their prefix", () => {
    const big = "a".repeat(300 * 1024);
    const [sanitized] = sanitizeMessagesForAnthropic([
      toolMessage([textFileBlock(big, "text/plain")]),
    ]);

    const [block] = sanitized.content as Array<{ type: string; text: string }>;

    expect(block.type).toBe("text");
    expect(block.text.startsWith("a".repeat(1024))).toBe(true);
    expect(block.text).toContain("truncated");
    expect(block.text.length).toBeLessThan(big.length);
  });

  test("keeps PDF file blocks and supported image blocks", () => {
    const content = [
      { type: "file", mimeType: "application/pdf", data: PNG_BASE64 },
      { type: "image", mimeType: "image/png", data: PNG_BASE64 },
    ];
    const message = toolMessage(content);

    const [sanitized] = sanitizeMessagesForAnthropic([message]);

    expect(sanitized).toBe(message);
    expect(sanitized.content).toEqual(content);
  });

  test("replaces unsupported image, audio, and video blocks", () => {
    const [sanitized] = sanitizeMessagesForAnthropic([
      toolMessage([
        { type: "image", mimeType: "image/tiff", data: PNG_BASE64 },
        { type: "audio", mimeType: "audio/mpeg", data: PNG_BASE64 },
        { type: "video", mimeType: "video/mp4", data: PNG_BASE64 },
      ]),
    ]);

    for (const block of sanitized.content as Array<{ type: string }>) {
      expect(block.type).toBe("text");
    }
  });

  test("leaves text blocks and mixed content intact", () => {
    const [sanitized] = sanitizeMessagesForAnthropic([
      toolMessage([
        { type: "text", text: "line 1" },
        { type: "file", mimeType: "application/zip", data: PNG_BASE64 },
      ]),
    ]);

    const blocks = sanitized.content as Array<{ type: string; text: string }>;

    expect(blocks[0]).toEqual({ type: "text", text: "line 1" });
    expect(blocks[1]?.type).toBe("text");
    expect(blocks[1]?.text).toContain("application/zip");
  });

  test("preserves tool message identity fields when rewriting", () => {
    const message = new ToolMessage({
      content: [
        { type: "file", mimeType: "application/zip", data: PNG_BASE64 },
      ] as ToolMessage["content"],
      name: "read_file",
      status: "success",
      tool_call_id: "call_42",
    });

    const [sanitized] = sanitizeMessagesForAnthropic([message]);

    expect(sanitized).toBeInstanceOf(ToolMessage);
    expect((sanitized as ToolMessage).tool_call_id).toBe("call_42");
    expect(sanitized.name).toBe("read_file");
    expect((sanitized as ToolMessage).status).toBe("success");
  });

  test("does not touch string-content tool messages or other message types", () => {
    const stringTool = toolMessage("plain output");
    const human = new HumanMessage("hello");
    const ai = new AIMessage("hi");

    const sanitized = sanitizeMessagesForAnthropic([stringTool, human, ai]);

    expect(sanitized[0]).toBe(stringTool);
    expect(sanitized[1]).toBe(human);
    expect(sanitized[2]).toBe(ai);
  });
});
