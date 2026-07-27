import { describe, expect, test } from "vitest";
import { parseStreamEvent } from "../src/agent/index.ts";

// Helpers to build fake stream chunks in the normalized protocol-event shape
// that `parseStreamEvent` now consumes:
//   { type: "event", method: "messages", params: { data, namespace } }
// isProtocolStreamEvent() checks type/method/params.data; the "messages"
// branch then feeds params.data to extractMessageText, which unwraps the
// [messageLike, metadata] tuple (isStreamMessageTuplePayload checks that
// metadata has langgraph_node etc.) and reads the message content blocks.

function makeChunk(contentBlocks: unknown[]): unknown {
  const message = {
    // marks this as a message-like record (isMessageLikeRecord check)
    content: contentBlocks,
    role: "assistant",
  };
  const metadata = {
    langgraph_node: "agent",
    run_id: "fake-run-id",
  };
  return {
    type: "event",
    method: "messages",
    params: {
      // the LangGraph `messages` payload: [message, metadata] tuple
      data: [message, metadata],
      // top-level (main graph) namespace, not a subgraph
      namespace: [],
    },
  };
}

describe("parseStreamEvent – content-block filtering", () => {
  test("plain text blocks still stream through normally", () => {
    const chunk = makeChunk([{ type: "text", text: "Hello from the agent." }]);
    const event = parseStreamEvent(chunk);

    expect(event).not.toBeNull();
    expect(event?.type).toBe("text");
    expect((event as { text: string }).text).toBe("Hello from the agent.");
  });

  test("file block with base64 content is fully suppressed", () => {
    // A 5 000-character base64 blob that mimics an actual file payload
    const base64Blob = "ZmYtZmFrZS1iYXNlNjQ=".repeat(250);
    const chunk = makeChunk([{ type: "file", content: base64Blob }]);
    const event = parseStreamEvent(chunk);

    // Nothing should reach the terminal
    expect(event).toBeNull();
  });

  test("image block is suppressed while adjacent text block still streams", () => {
    const base64Image = "iVBORw0KGgoAAAANSUhEUg==".repeat(100);
    const chunk = makeChunk([
      { type: "image", content: base64Image },
      { type: "text", text: "Here is your result." },
    ]);
    const event = parseStreamEvent(chunk);

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
    const event = parseStreamEvent(chunk);

    expect(event).toBeNull();
  });

  test("image_url block is suppressed (matches type.includes('image'))", () => {
    const chunk = makeChunk([
      { type: "image_url", content: "data:image/png;base64,abc123==" },
    ]);
    const event = parseStreamEvent(chunk);

    expect(event).toBeNull();
  });
});
