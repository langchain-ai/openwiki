import { describe, expect, test } from "vitest";
import { guardTruncatedToolCall } from "../src/agent/index.ts";

type MessageLocation = {
  namespace?: string[];
  node?: string;
};

function messageEvent(
  data: Record<string, unknown>,
  { namespace = ["model"], node = "agent" }: MessageLocation = {},
) {
  return {
    method: "messages",
    params: {
      data,
      namespace,
      node,
      timestamp: 0,
    },
    type: "event",
  };
}

function invalidToolCall(runId: string, location?: MessageLocation) {
  return messageEvent(
    {
      content: {
        args: '{"content":"sensitive generated content',
        name: "write_file",
        type: "invalid_tool_call",
      },
      event: "content-block-finish",
      run_id: runId,
    },
    location,
  );
}

function messageFinish(
  runId: string,
  reason: string,
  location?: MessageLocation,
) {
  return messageEvent(
    {
      event: "message-finish",
      reason,
      run_id: runId,
    },
    location,
  );
}

describe("guardTruncatedToolCall", () => {
  test("fails when the same model run truncates an invalid tool call", () => {
    const state = guardTruncatedToolCall(new Set(), invalidToolCall("run-1"));

    const error = (() => {
      try {
        guardTruncatedToolCall(state, messageFinish("run-1", "length"));
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(
      "Model output reached its token limit before completing a tool call.",
    );
    expect(String(error)).not.toContain("sensitive generated content");
  });

  test("does not combine signals from different model runs", () => {
    const state = guardTruncatedToolCall(new Set(), invalidToolCall("run-1"));

    const unchanged = guardTruncatedToolCall(
      state,
      messageFinish("run-2", "length"),
    );

    expect(unchanged).toBe(state);
    expect(() =>
      guardTruncatedToolCall(unchanged, messageFinish("run-1", "length")),
    ).toThrow();
  });

  test.each([
    [
      "namespaces",
      { namespace: ["parent", "model"] },
      { namespace: ["parent", "subgraph", "model"] },
    ],
    ["nodes", { node: "model-a" }, { node: "model-b" }],
  ] satisfies Array<[string, MessageLocation, MessageLocation]>)(
    "does not combine the same run id across different %s",
    (_scope, invalidLocation, finishLocation) => {
      const state = guardTruncatedToolCall(
        new Set(),
        invalidToolCall("shared-run", invalidLocation),
      );

      const unchanged = guardTruncatedToolCall(
        state,
        messageFinish("shared-run", "stop", finishLocation),
      );

      expect(unchanged).toBe(state);
      expect(() =>
        guardTruncatedToolCall(
          unchanged,
          messageFinish("shared-run", "length", invalidLocation),
        ),
      ).toThrow();
    },
  );

  test("clears an invalid call after a non-length finish", () => {
    const state = guardTruncatedToolCall(new Set(), invalidToolCall("run-1"));
    const cleared = guardTruncatedToolCall(
      state,
      messageFinish("run-1", "stop"),
    );

    expect(cleared.size).toBe(0);
    expect(() =>
      guardTruncatedToolCall(cleared, messageFinish("run-1", "length")),
    ).not.toThrow();
  });

  test("leaves normal text and valid tool calls unchanged", () => {
    const initial = new Set<string>();
    const afterText = guardTruncatedToolCall(
      initial,
      messageEvent({
        delta: { text: "hello", type: "text-delta" },
        event: "content-block-delta",
        run_id: "run-1",
      }),
    );
    const afterToolCall = guardTruncatedToolCall(
      afterText,
      messageEvent({
        content: {
          args: { file_path: "/openwiki/index.md" },
          name: "write_file",
          type: "tool_call",
        },
        event: "content-block-finish",
        run_id: "run-1",
      }),
    );

    expect(afterText).toBe(initial);
    expect(afterToolCall).toBe(initial);
    expect(() =>
      guardTruncatedToolCall(afterToolCall, messageFinish("run-1", "length")),
    ).not.toThrow();
  });

  test("ignores events without a model run id", () => {
    const initial = new Set<string>();
    const state = guardTruncatedToolCall(
      initial,
      messageEvent({
        content: { type: "invalid_tool_call" },
        event: "content-block-finish",
      }),
    );

    expect(state).toBe(initial);
  });
});
