import { describe, expect, test } from "vitest";
import { parseStreamEvent } from "../../src/agent/index.ts";

// `formatToolArgs` is module-private, so these drive it the way the CLI does:
// through the exported stream-event parser, whose "tools" branch builds the
// displayed `call` string from the tool's input.
function makeToolStartChunk(name: string, input: unknown): unknown {
  return {
    type: "event",
    method: "tools",
    params: {
      data: { event: "on_tool_start", input, name },
      namespace: [],
    },
  };
}

function callFor(name: string, input: unknown): string {
  const event = parseStreamEvent(makeToolStartChunk(name, input));

  expect(event?.type).toBe("tool_start");

  return (event as { call: string }).call;
}

describe("tool_start argument formatting", () => {
  test("renders a stringified array input as a value list", () => {
    expect(callFor("search", '["a","b"]')).toBe('search("a", "b")');
  });

  test("renders a raw array input as a value list", () => {
    expect(callFor("search", ["a", "b"])).toBe('search("a", "b")');
  });

  test("renders mixed array members without index keys", () => {
    expect(callFor("search", [1, "two", true])).toBe('search(1, "two", true)');
  });

  test("still renders object inputs as key=value pairs", () => {
    expect(callFor("read", { limit: 2, path: "docs/index.md" })).toBe(
      'read(limit=2, path="docs/index.md")',
    );
  });

  test("still renders a scalar input as a bare value", () => {
    expect(callFor("echo", '"hello"')).toBe('echo("hello")');
  });

  test("still renders an empty argument list for a null input", () => {
    expect(callFor("noop", null)).toBe("noop()");
  });
});
