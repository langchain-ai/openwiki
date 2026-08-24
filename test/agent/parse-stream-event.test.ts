import { describe, expect, test } from "vitest";
import { parseStreamEvent } from "../../src/agent/index.ts";
import type { OpenWikiRunEvent } from "../../src/agent/types.ts";

// parseStreamEvent is the untrusted-input boundary between the deepagents
// stream and OpenWiki's terminal renderer: every chunk it sees originates from
// a third-party model/runtime, so the discrimination between "text to show",
// "tool activity", and "ignore" must hold up against malformed and adversarial
// shapes. stream-redaction.test.ts already covers content-block suppression on
// the `messages` tuple path; these cases exercise the remaining discrimination
// branches (protocol guard, subgraph tagging, nested/serialized message
// shapes, delta variants, and the whole `tools` branch) that path never hits.

/**
 * Wraps a `messages` payload in the normalized protocol-event envelope that
 * isProtocolStreamEvent() accepts. Any non-empty namespace marks a subgraph.
 */
function messagesChunk(data: unknown, namespace: unknown[] = []): unknown {
  return {
    type: "event",
    method: "messages",
    params: { data, namespace },
  };
}

/**
 * Wraps a `tools` payload (the tool lifecycle record) in the protocol-event
 * envelope.
 */
function toolsChunk(data: unknown, namespace: unknown[] = []): unknown {
  return {
    type: "event",
    method: "tools",
    params: { data, namespace },
  };
}

/** Narrows a non-null text event so tests can read `.text` without casts. */
function expectText(event: OpenWikiRunEvent | null): string {
  expect(event).not.toBeNull();
  expect(event?.type).toBe("text");
  return (event as { text: string }).text;
}

describe("parseStreamEvent – protocol guard", () => {
  test.each([
    ["non-object", 42],
    ["null", null],
    ["missing method", { type: "event", params: { data: "x" } }],
    ["non-event type", { type: "values", method: "messages", params: {} }],
    ["params without data", { type: "event", method: "messages", params: {} }],
  ])(
    "returns null for a chunk that is not a protocol event (%s)",
    (_label, chunk) => {
      // Anything failing the isProtocolStreamEvent shape check must be dropped
      // rather than misinterpreted as renderable content.
      expect(parseStreamEvent(chunk)).toBeNull();
    },
  );

  test("returns null for a protocol event with an unhandled method", () => {
    // Only `messages` and `tools` are actionable; other well-formed methods
    // (e.g. `values`, `updates`) are silently ignored.
    expect(parseStreamEvent(toolsChunkWithMethod("values"))).toBeNull();
  });
});

/** A well-formed protocol event whose method is neither messages nor tools. */
function toolsChunkWithMethod(method: string): unknown {
  return { type: "event", method, params: { data: {}, namespace: [] } };
}

describe("parseStreamEvent – messages source tagging", () => {
  test("top-level namespace tags the event as coming from the main graph", () => {
    const event = parseStreamEvent(messagesChunk("hello from main", []));

    expect(event).toMatchObject({ source: "main", type: "text" });
    expect(expectText(event)).toBe("hello from main");
  });

  test("a nested namespace tags the event as coming from a subgraph", () => {
    const event = parseStreamEvent(messagesChunk("hello from sub", ["task"]));

    expect(event).toMatchObject({ source: "subgraph", type: "text" });
  });
});

describe("parseStreamEvent – message text extraction shapes", () => {
  test("a bare string payload streams through", () => {
    expect(expectText(parseStreamEvent(messagesChunk("plain")))).toBe("plain");
  });

  test("an array of content blocks (no tuple metadata) is concatenated", () => {
    const event = parseStreamEvent(
      messagesChunk([
        { type: "text", text: "one " },
        { type: "text", text: "two" },
      ]),
    );

    // A 2-element array that is NOT a [message, metadata] tuple is walked as a
    // list of blocks; the first block with text wins the item scan.
    expect(expectText(event)).toBe("one ");
  });

  test("a human-role message is suppressed (only ai/assistant is rendered)", () => {
    // shouldReadMessageRecord must not echo the user's own turn back to the
    // terminal; only assistant output should stream.
    const event = parseStreamEvent(
      messagesChunk({ role: "human", content: "my prompt" }),
    );

    expect(event).toBeNull();
  });

  test("text is read out of a nested `chunk` field", () => {
    const event = parseStreamEvent(
      messagesChunk({ chunk: { role: "assistant", content: "from chunk" } }),
    );

    expect(expectText(event)).toBe("from chunk");
  });

  test("text is read out of a nested `message` field", () => {
    const event = parseStreamEvent(
      messagesChunk({ message: { role: "ai", content: "from message" } }),
    );

    expect(expectText(event)).toBe("from message");
  });

  test("text is recovered from a serialized LangChain message via kwargs", () => {
    // A serialized AIMessageChunk identifies its role through the trailing
    // segment of its `id` tuple, and its content lives under `kwargs`.
    const event = parseStreamEvent(
      messagesChunk({
        id: ["langchain", "schema", "messages", "AIMessageChunk"],
        kwargs: { content: "serialized body" },
      }),
    );

    expect(expectText(event)).toBe("serialized body");
  });

  test("role is honored through a `_getType` method", () => {
    const event = parseStreamEvent(
      messagesChunk({ _getType: () => "ai", content: "typed ai" }),
    );

    expect(expectText(event)).toBe("typed ai");
  });

  test("a throwing `_getType` does not crash extraction", () => {
    // A hostile message object whose _getType throws must be treated as
    // unknown-role, not propagate the exception up through the stream loop.
    const event = parseStreamEvent(
      messagesChunk({
        _getType: () => {
          throw new Error("boom");
        },
        content: "still readable",
      }),
    );

    // role resolves to null -> record is still read -> content streams.
    expect(expectText(event)).toBe("still readable");
  });

  test("falls back to the `output` key when content yields nothing", () => {
    const event = parseStreamEvent(
      messagesChunk({ role: "assistant", content: [], output: "fallback" }),
    );

    expect(expectText(event)).toBe("fallback");
  });
});

describe("parseStreamEvent – protocol streaming sub-events", () => {
  // A bare protocol-framing record (`{ event, delta }`) carries no message
  // `content` and no recognizable role, so extractMessageText finds nothing to
  // read and the frame resolves to null. Real streamed delta text arrives
  // wrapped in a content block (see the content-array delta case below), which
  // is the path that actually surfaces text.
  test.each([
    ["text-delta frame", { type: "text-delta", text: "streamed" }],
    [
      "block-delta frame",
      { type: "block-delta", fields: { text: "block body" } },
    ],
    ["bare-text delta", { text: "bare delta text" }],
    ["nested-delta string", { delta: "nested delta" }],
  ])(
    "a bare content-block-delta record (%s) surfaces no renderable text",
    (_label, delta) => {
      expect(
        parseStreamEvent(
          messagesChunk({ event: "content-block-delta", delta }),
        ),
      ).toBeNull();
    },
  );

  test("content-block-start reads text from the block content", () => {
    const event = parseStreamEvent(
      messagesChunk({
        event: "content-block-start",
        content: { type: "text", text: "started" },
      }),
    );

    expect(expectText(event)).toBe("started");
  });

  test.each([
    "message-start",
    "message-finish",
    "content-block-finish",
    "error",
  ])("the %s lifecycle event produces no renderable text", (event) => {
    // These framing events carry no user-visible text; they must resolve to
    // null so they do not emit empty terminal lines.
    expect(parseStreamEvent(messagesChunk({ event }))).toBeNull();
  });

  test("reasoning and tool content blocks are suppressed", () => {
    // Chain-of-thought and tool-call blocks must never be surfaced as prose,
    // even though they may carry a `text` field.
    const event = parseStreamEvent(
      messagesChunk({
        role: "assistant",
        content: [
          { type: "reasoning", text: "internal thought" },
          { type: "tool_use", text: "call args" },
          { type: "text", text: "visible answer" },
        ],
      }),
    );

    const text = expectText(event);
    expect(text).toContain("visible answer");
    expect(text).not.toContain("internal thought");
    expect(text).not.toContain("call args");
  });

  test("output_text content blocks are surfaced", () => {
    const event = parseStreamEvent(
      messagesChunk({
        role: "assistant",
        content: [{ type: "output_text", output_text: "responses api text" }],
      }),
    );

    expect(expectText(event)).toBe("responses api text");
  });

  test("a content block nesting text under `delta` is unwrapped", () => {
    const event = parseStreamEvent(
      messagesChunk({
        role: "assistant",
        content: [{ delta: { type: "text-delta", text: "deep" } }],
      }),
    );

    expect(expectText(event)).toBe("deep");
  });
});

describe("parseStreamEvent – tools branch", () => {
  test("returns null when the tools payload is not a record", () => {
    expect(parseStreamEvent(toolsChunk("not-a-record"))).toBeNull();
  });

  test("returns null for an unrecognized tool lifecycle event", () => {
    expect(
      parseStreamEvent(toolsChunk({ event: "on_tool_middle" })),
    ).toBeNull();
  });

  test("on_tool_start yields a tool_start event with a formatted call line", () => {
    const event = parseStreamEvent(
      toolsChunk({
        event: "on_tool_start",
        name: "write_file",
        toolCallId: "call-1",
        input: { file_path: "/a.md", contents: "x" },
      }),
    );

    expect(event).toMatchObject({
      type: "tool_start",
      id: "call-1",
      name: "write_file",
    });
    // formatToolArgs renders record inputs as key=value with JSON-quoted strings.
    expect((event as { call: string }).call).toBe(
      'write_file(file_path="/a.md", contents="x")',
    );
  });

  test("the `execute` tool name is capitalized in the call line", () => {
    const event = parseStreamEvent(
      toolsChunk({ event: "on_tool_start", name: "execute", input: "ls" }),
    );

    // formatToolCallName maps execute -> Execute; a bare non-JSON string input
    // is not a record, so it is rendered as a single JSON-quoted scalar.
    expect((event as { call: string }).call).toBe('Execute("ls")');
    expect(event).toMatchObject({ type: "tool_start", name: "execute" });
  });

  test("a missing tool name and call id fall back to synthetic values", () => {
    const event = parseStreamEvent(
      toolsChunk({ event: "on_tool_start", input: { q: 1 } }),
    );

    // Absent name -> "tool"; absent toolCallId -> the resolved name itself.
    expect(event).toMatchObject({ type: "tool_start", name: "tool" });
    expect((event as { id: string }).id).toBe("tool");
  });

  test("a stringified-JSON input is parsed before formatting", () => {
    const event = parseStreamEvent(
      toolsChunk({
        event: "on_tool_start",
        name: "search",
        toolCallId: "c2",
        input: '{"query":"hi"}',
      }),
    );

    expect((event as { call: string }).call).toBe('search(query="hi")');
    expect(event).toMatchObject({ id: "c2" });
  });

  test("on_tool_end yields a finished tool_end event", () => {
    const event = parseStreamEvent(
      toolsChunk({
        event: "on_tool_end",
        name: "write_file",
        toolCallId: "c3",
      }),
    );

    expect(event).toEqual({
      type: "tool_end",
      id: "c3",
      name: "write_file",
      status: "finished",
    });
  });

  test("preserves tool activity emitted by a subgraph", () => {
    const event = parseStreamEvent(
      toolsChunk(
        {
          event: "on_tool_start",
          name: "read_file",
          toolCallId: "nested-read",
          input: { path: "/src/agent/index.ts" },
        },
        ["task"],
      ),
    );

    expect(event).toEqual({
      type: "tool_start",
      call: 'read_file(path="/src/agent/index.ts")',
      id: "nested-read",
      input: { path: "/src/agent/index.ts" },
      name: "read_file",
    });
  });

  test("on_tool_error yields a tool_end event with error status", () => {
    const parsed = parseStreamEvent(
      toolsChunk({
        event: "on_tool_error",
        name: "write_file",
        toolCallId: "c4",
      }),
    );

    expect(parsed).toMatchObject({ type: "tool_end", status: "error" });
  });

  test("an array tool input is rendered as a positional value list", () => {
    const event = parseStreamEvent(
      toolsChunk({
        event: "on_tool_start",
        name: "batch",
        toolCallId: "c5",
        input: ["a", 2],
      }),
    );

    // formatToolArgs checks Array.isArray before the record branch, so arrays
    // render positionally as a value list rather than keyed by index.
    expect((event as { call: string }).call).toBe('batch("a", 2)');
  });

  test("an absent tool input renders an empty argument list", () => {
    const event = parseStreamEvent(
      toolsChunk({ event: "on_tool_start", name: "noop", toolCallId: "c6" }),
    );

    expect((event as { call: string }).call).toBe("noop()");
  });
});
