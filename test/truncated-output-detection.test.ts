import { describe, expect, test } from "vitest";

import {
  detectTruncatedOutput,
  parseStreamEvent,
} from "../src/agent/index.ts";

// When a model hit its output limit mid tool call, the v3 stream said so twice —
// content-block-finish with content.type "invalid_tool_call", and message-finish
// with reason "length" — and both were classified as "no text to emit" and
// dropped. The incomplete call never ran, so a requested write_file simply did
// not happen while the run could still finish looking successful (issue #458).

function chunk(data: unknown) {
  return {
    method: "messages",
    params: { data, namespace: [] },
    type: "event",
  };
}

describe("detectTruncatedOutput", () => {
  test("an invalid_tool_call block is reported with the tool name", () => {
    const message = detectTruncatedOutput(
      chunk({
        content: { name: "write_file", type: "invalid_tool_call" },
        event: "content-block-finish",
      }),
    );

    expect(message).toBeTruthy();
    expect(message).toContain("write_file");
    expect(message).toContain("output tokens");
    expect(message).toContain("was not executed");
  });

  test("an invalid_tool_call without a name still reports", () => {
    const message = detectTruncatedOutput(
      chunk({
        content: { type: "invalid_tool_call" },
        event: "content-block-finish",
      }),
    );

    expect(message).toContain("a tool");
  });

  test("message-finish reason=length is reported", () => {
    const message = detectTruncatedOutput(
      chunk({ event: "message-finish", reason: "length" }),
    );

    expect(message).toContain("output token limit");
    expect(message).toContain("truncated");
  });

  test("the finish_reason spelling is also honoured", () => {
    const message = detectTruncatedOutput(
      chunk({ event: "message-finish", finish_reason: "length" }),
    );

    expect(message).toContain("output token limit");
  });

  test("a normal stop is not a truncation", () => {
    expect(
      detectTruncatedOutput(chunk({ event: "message-finish", reason: "stop" })),
    ).toBeNull();
  });

  test("a normal tool-use block is not a truncation", () => {
    expect(
      detectTruncatedOutput(
        chunk({
          content: { name: "write_file", type: "tool_use" },
          event: "content-block-finish",
        }),
      ),
    ).toBeNull();
  });

  test("ordinary text chunks are not truncations", () => {
    expect(
      detectTruncatedOutput(
        chunk({ delta: { text: "hello", type: "text" }, event: "content-block-delta" }),
      ),
    ).toBeNull();
  });

  test("non-protocol chunks are ignored", () => {
    expect(detectTruncatedOutput(null)).toBeNull();
    expect(detectTruncatedOutput({ nope: true })).toBeNull();
    expect(detectTruncatedOutput("string chunk")).toBeNull();
  });

  test("the tools channel is not inspected", () => {
    expect(
      detectTruncatedOutput({
        method: "tools",
        params: { data: { event: "message-finish", reason: "length" }, namespace: [] },
        type: "event",
      }),
    ).toBeNull();
  });

  test("the same chunks still produce no user-visible text event", () => {
    // Pins the old behaviour that made this invisible: parseStreamEvent returns
    // null for both, which is why the run could finish reporting success.
    expect(
      parseStreamEvent(
        chunk({
          content: { name: "write_file", type: "invalid_tool_call" },
          event: "content-block-finish",
        }),
      ),
    ).toBeNull();
    expect(
      parseStreamEvent(chunk({ event: "message-finish", reason: "length" })),
    ).toBeNull();
  });
});
