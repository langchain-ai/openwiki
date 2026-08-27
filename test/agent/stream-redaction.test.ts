import { describe, expect, test } from "vitest";
import { parseAgentStreamChunk } from "../../src/agent/index.ts";

function makeChunk(
  contentBlocks: unknown[],
  namespace: string[] = [],
): unknown {
  const message = {
    content: contentBlocks,
    role: "assistant",
  };
  const metadata = {
    langgraph_node: "agent",
    run_id: "fake-run-id",
  };
  return [namespace, "messages", [message, metadata]];
}

describe("parseAgentStreamChunk", () => {
  test("plain text blocks still stream through normally", () => {
    const chunk = makeChunk([{ type: "text", text: "Hello from the agent." }]);
    const event = parseAgentStreamChunk(chunk);

    expect(event).not.toBeNull();
    expect(event?.type).toBe("text");
    expect((event as { text: string }).text).toBe("Hello from the agent.");
  });

  test("file block with base64 content is fully suppressed", () => {
    // A 5 000-character base64 blob that mimics an actual file payload
    const base64Blob = "ZmYtZmFrZS1iYXNlNjQ=".repeat(250);
    const chunk = makeChunk([{ type: "file", content: base64Blob }]);
    const event = parseAgentStreamChunk(chunk);

    // Nothing should reach the terminal
    expect(event).toBeNull();
  });

  test("image block is suppressed while adjacent text block still streams", () => {
    const base64Image = "iVBORw0KGgoAAAANSUhEUg==".repeat(100);
    const chunk = makeChunk([
      { type: "image", content: base64Image },
      { type: "text", text: "Here is your result." },
    ]);
    const event = parseAgentStreamChunk(chunk);

    expect(event).not.toBeNull();
    expect(event?.type).toBe("text");
    // The base64 blob must NOT appear in the output
    expect((event as { text: string }).text).not.toContain("iVBORw0");
    expect((event as { text: string }).text).toContain("Here is your result.");
  });

  test("input_file block is suppressed (matches type.includes('file'))", () => {
    const chunk = makeChunk([
      { type: "input_file", content: "ZmFrZWZpbGVkYXRh" },
    ]);
    const event = parseAgentStreamChunk(chunk);

    expect(event).toBeNull();
  });

  test("image_url block is suppressed (matches type.includes('image'))", () => {
    const chunk = makeChunk([
      { type: "image_url", content: "data:image/png;base64,abc123==" },
    ]);
    const event = parseAgentStreamChunk(chunk);

    expect(event).toBeNull();
  });

  test("preserves nested task output", () => {
    const event = parseAgentStreamChunk(
      makeChunk([{ type: "text", text: "Task output" }], ["task"]),
    );

    expect(event).toMatchObject({
      source: "subgraph",
      text: "Task output",
      type: "text",
    });
  });

  test("normalizes tool lifecycle events", () => {
    expect(
      parseAgentStreamChunk([
        [],
        "tools",
        {
          event: "on_tool_start",
          input: { path: "/README.md" },
          name: "read_file",
          toolCallId: "call-1",
        },
      ]),
    ).toMatchObject({
      id: "call-1",
      name: "read_file",
      type: "tool_start",
    });
    expect(
      parseAgentStreamChunk([
        [],
        "tools",
        { event: "on_tool_end", name: "read_file", toolCallId: "call-1" },
      ]),
    ).toEqual({
      id: "call-1",
      name: "read_file",
      status: "finished",
      type: "tool_end",
    });
    expect(
      parseAgentStreamChunk([
        [],
        "tools",
        { event: "on_tool_error", name: "grep", toolCallId: "call-2" },
      ]),
    ).toEqual({
      id: "call-2",
      name: "grep",
      status: "error",
      type: "tool_end",
    });
  });

  test("rejects malformed stream chunks", () => {
    expect(parseAgentStreamChunk({ content: "not a tuple" })).toBeNull();
    expect(
      parseAgentStreamChunk([["namespace"], ["not a message"]]),
    ).toBeNull();
  });
});
