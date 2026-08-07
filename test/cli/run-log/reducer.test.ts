import { describe, expect, test } from "vitest";
import { appendRunLogEvent } from "../../../src/cli/run-log/reducer.ts";
import type { OpenWikiRunEvent } from "../../../src/agent/types.ts";
import type { RunLogItem } from "../../../src/cli/run-log/types.ts";

/**
 * Builds a fresh log-id ref, mirroring the useRef the App threads through.
 */
function idRef(start = 0): { current: number } {
  return { current: start };
}

describe("appendRunLogEvent text handling", () => {
  test("appends a text line and advances the id", () => {
    const ref = idRef();
    const log = appendRunLogEvent([], { type: "text", text: "hello" }, ref);

    expect(log).toEqual([{ id: 0, type: "text", content: "hello" }]);
    expect(ref.current).toBe(1);
  });

  test("drops empty and subgraph text without touching the log", () => {
    const existing: RunLogItem[] = [{ id: 0, type: "text", content: "a" }];

    expect(
      appendRunLogEvent(existing, { type: "text", text: "" }, idRef()),
    ).toBe(existing);
    expect(
      appendRunLogEvent(
        existing,
        { type: "text", source: "subgraph", text: "x" },
        idRef(),
      ),
    ).toBe(existing);
  });

  test("concatenates consecutive assistant text onto the last line", () => {
    const ref = idRef(1);
    const log = appendRunLogEvent(
      [{ id: 0, type: "text", content: "foo" }],
      { type: "text", text: "bar" },
      ref,
    );

    expect(log).toEqual([{ id: 0, type: "text", content: "foobar" }]);
    expect(ref.current).toBe(1);
  });

  test("appends a debug line", () => {
    const log = appendRunLogEvent(
      [],
      { type: "debug", message: "dbg" },
      idRef(),
    );
    expect(log).toEqual([{ id: 0, type: "debug", content: "dbg" }]);
  });
});

describe("appendRunLogEvent tool grouping", () => {
  const start = (id: string, name = "grep"): OpenWikiRunEvent => ({
    type: "tool_start",
    call: `${name}()`,
    id,
    input: {},
    name,
  });

  test("starts a running tool line for the first tool call", () => {
    const log = appendRunLogEvent([], start("t1"), idRef());

    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      type: "tool",
      status: "running",
      actionCount: 1,
      activeToolCallIds: ["t1"],
      toolCallId: "t1",
    });
  });

  test("merges a second tool call into the same group", () => {
    const ref = idRef();
    let log = appendRunLogEvent([], start("t1"), ref);
    log = appendRunLogEvent(log, start("t2"), ref);

    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      status: "running",
      actionCount: 2,
      activeToolCallIds: ["t1", "t2"],
    });
  });

  test("settles a single tool call to done on a finished end", () => {
    const ref = idRef();
    let log = appendRunLogEvent([], start("t1"), ref);
    log = appendRunLogEvent(
      log,
      { type: "tool_end", id: "t1", name: "grep", status: "finished" },
      ref,
    );

    expect(log[0]).toMatchObject({
      status: "done",
      errorCount: 0,
      activeToolCallIds: [],
    });
  });

  test("marks the group errored and counts the failure", () => {
    const ref = idRef();
    let log = appendRunLogEvent([], start("t1"), ref);
    log = appendRunLogEvent(
      log,
      { type: "tool_end", id: "t1", name: "grep", status: "error" },
      ref,
    );

    expect(log[0]).toMatchObject({ status: "error", errorCount: 1 });
  });

  test("leaves the log unchanged for an unknown tool_end id", () => {
    const ref = idRef();
    const log = appendRunLogEvent([], start("t1"), ref);
    const after = appendRunLogEvent(
      log,
      {
        type: "tool_end",
        id: "does-not-exist",
        name: "grep",
        status: "finished",
      },
      ref,
    );

    expect(after).toBe(log);
  });

  test("stays running until every call in the group has ended", () => {
    const ref = idRef();
    let log = appendRunLogEvent([], start("t1"), ref);
    log = appendRunLogEvent(log, start("t2"), ref);

    log = appendRunLogEvent(
      log,
      { type: "tool_end", id: "t1", name: "grep", status: "finished" },
      ref,
    );
    expect(log[0]).toMatchObject({
      status: "running",
      activeToolCallIds: ["t2"],
    });

    log = appendRunLogEvent(
      log,
      { type: "tool_end", id: "t2", name: "grep", status: "finished" },
      ref,
    );
    expect(log[0]).toMatchObject({ status: "done", activeToolCallIds: [] });
  });
});
