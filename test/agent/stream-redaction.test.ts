import { describe, expect, test } from "vitest";
import { parseAgentStreamChunk } from "../../src/agent/index.ts";
import { appendRunLogEvent } from "../../src/cli/run-log/reducer.ts";

const MODEL_REQUEST_NAMESPACE = "model_request:fake-request-id";
const MODEL_RESPONSE_TEXT = "Hello from the primary model.";

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

  test("renders top-level model request text as main assistant output", () => {
    const event = parseAgentStreamChunk(
      makeChunk(
        [{ type: "text", text: MODEL_RESPONSE_TEXT }],
        [MODEL_REQUEST_NAMESPACE],
      ),
    );

    expect(event).toMatchObject({
      source: "main",
      text: MODEL_RESPONSE_TEXT,
      type: "text",
    });
    expect(
      event === null ? [] : appendRunLogEvent([], event, { current: 0 }),
    ).toEqual([{ content: MODEL_RESPONSE_TEXT, id: 0, type: "text" }]);
  });

  test("keeps nested model request text classified as subgraph output", () => {
    const event = parseAgentStreamChunk(
      makeChunk(
        [{ type: "text", text: MODEL_RESPONSE_TEXT }],
        ["task", MODEL_REQUEST_NAMESPACE],
      ),
    );

    expect(event).toMatchObject({ source: "subgraph", type: "text" });
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

  // "updates" mode is the default stream mode for the openai-compatible
  // provider. The payload is a per-node state diff rather than raw message
  // tokens, so the shape is { nodeName: { messages: [...] } }. Without
  // handling this mode, plain-text replies from openai-compatible endpoints
  // are silently dropped and the TUI shows "No assistant output captured".
  test("extracts assistant text from an updates-mode state diff", () => {
    const chunk = [
      [],
      "updates",
      {
        agent: {
          messages: [
            {
              role: "assistant",
              content: "Who am I? I am OpenWiki.",
            },
          ],
        },
      },
    ];

    const event = parseAgentStreamChunk(chunk);

    expect(event).not.toBeNull();
    expect(event?.type).toBe("text");
    expect((event as { text: string }).text).toBe("Who am I? I am OpenWiki.");
    expect((event as { source: string }).source).toBe("main");
  });

  test("tags updates from a subgraph namespace as subgraph source", () => {
    const chunk = [
      ["task"],
      "updates",
      { agent: { messages: [{ role: "assistant", content: "sub answer" }] } },
    ];

    const event = parseAgentStreamChunk(chunk);

    expect(event).toMatchObject({ source: "subgraph", type: "text" });
  });

  test("returns null for an updates chunk with no node outputs", () => {
    // An empty state diff carries no messages to display.
    expect(parseAgentStreamChunk([[], "updates", {}])).toBeNull();
  });

  test("returns null for an updates chunk with a non-record payload", () => {
    expect(parseAgentStreamChunk([[], "updates", "not-a-record"])).toBeNull();
    expect(parseAgentStreamChunk([[], "updates", null])).toBeNull();
  });

  test("skips tool-call messages in updates chunks, surfaces adjacent text", () => {
    const chunk = [
      [],
      "updates",
      {
        agent: {
          messages: [
            {
              role: "assistant",
              content: "",
              tool_calls: [{ name: "read_file", args: {} }],
            },
          ],
        },
      },
    ];

    // A message that carries only tool calls has no renderable text.
    expect(parseAgentStreamChunk(chunk)).toBeNull();
  });
});
