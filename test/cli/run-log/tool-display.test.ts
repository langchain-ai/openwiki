import { describe, expect, test } from "vitest";
import {
  countTodoItems,
  countToolTargets,
  createToolDisplay,
  formatCount,
  parseToolInput,
  pickToolDisplay,
  pickVariantIndex,
} from "../../../src/cli/run-log/tool-display.ts";
import type { OpenWikiRunEvent } from "../../../src/agent/types.ts";

type ToolStartEvent = Extract<OpenWikiRunEvent, { type: "tool_start" }>;

/**
 * Builds a tool_start event with sensible defaults for the fields under test.
 */
function toolStart(overrides: Partial<ToolStartEvent> = {}): ToolStartEvent {
  return {
    type: "tool_start",
    call: "tool()",
    id: "call-1",
    input: {},
    name: "read_file",
    ...overrides,
  };
}

describe("createToolDisplay", () => {
  test("counts a single file target and keeps the copy singular", () => {
    const display = createToolDisplay(
      toolStart({ name: "read_file", input: { path: "a.ts" } }),
    );

    expect(display.running).toContain("1 file");
    expect(display.done).toContain("1 file");
    expect(display.showDetail).toBe(true);
  });

  test("pluralizes when multiple files are targeted", () => {
    const display = createToolDisplay(
      toolStart({ name: "read_file", input: { paths: ["a.ts", "b.ts"] } }),
    );

    expect(display.running).toContain("2 files");
    expect(display.done).toContain("2 files");
  });

  test("hides call detail for edit_file and write_file", () => {
    expect(
      createToolDisplay(toolStart({ name: "edit_file", input: {} })).showDetail,
    ).toBe(false);
    expect(
      createToolDisplay(toolStart({ name: "write_file", input: {} }))
        .showDetail,
    ).toBe(false);
  });

  test("falls back to the raw call for an unknown tool", () => {
    const display = createToolDisplay(
      toolStart({ name: "mystery_tool", call: "mystery_tool(x)" }),
    );

    expect(display).toEqual({
      done: "mystery_tool(x)",
      running: "mystery_tool(x)",
      showDetail: false,
    });
  });

  test("is deterministic for the same event", () => {
    const event = toolStart({ name: "grep", id: "abc" });
    expect(createToolDisplay(event)).toEqual(createToolDisplay(event));
  });
});

describe("pickToolDisplay", () => {
  test("selects the pair at the wrapped variant index", () => {
    expect(pickToolDisplay(3, ["r0", "r1"], ["d0", "d1"])).toEqual({
      running: "r1",
      done: "d1",
      showDetail: true,
    });
  });

  test("honors an explicit showDetail override", () => {
    expect(pickToolDisplay(0, ["r0"], ["d0"], false).showDetail).toBe(false);
  });
});

describe("parseToolInput", () => {
  test("parses a JSON string payload", () => {
    expect(parseToolInput('{"path":"a.ts"}')).toEqual({ path: "a.ts" });
  });

  test("returns non-string input unchanged", () => {
    const input = { path: "a.ts" };
    expect(parseToolInput(input)).toBe(input);
  });

  test("returns the original string when it is not valid JSON", () => {
    expect(parseToolInput("not json")).toBe("not json");
  });
});

describe("countToolTargets", () => {
  test("counts array inputs directly", () => {
    expect(countToolTargets(["a", "b", "c"], ["path"])).toBe(3);
  });

  test("counts the first matching array-valued key", () => {
    expect(countToolTargets({ paths: ["a", "b"] }, ["path", "paths"])).toBe(2);
  });

  test("counts a single non-empty string key as one", () => {
    expect(countToolTargets({ path: "a.ts" }, ["path"])).toBe(1);
  });

  test("defaults to one for non-record input", () => {
    expect(countToolTargets(42, ["path"])).toBe(1);
  });
});

describe("countTodoItems", () => {
  test("counts todos, falling back to items", () => {
    expect(countTodoItems({ todos: [1, 2, 3] })).toBe(3);
    expect(countTodoItems({ items: [1, 2] })).toBe(2);
  });

  test("defaults to one when no list is present", () => {
    expect(countTodoItems({})).toBe(1);
    expect(countTodoItems("nope")).toBe(1);
  });
});

describe("formatCount", () => {
  test("uses the singular noun only for a count of one", () => {
    expect(formatCount(1, "file", "files")).toBe("1 file");
    expect(formatCount(0, "file", "files")).toBe("0 files");
    expect(formatCount(3, "file", "files")).toBe("3 files");
  });
});

describe("pickVariantIndex", () => {
  test("is deterministic and non-negative for a given seed", () => {
    const value = pickVariantIndex("read_file:call-1");
    expect(value).toBe(pickVariantIndex("read_file:call-1"));
    expect(value).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(value)).toBe(true);
  });

  test("varies across different seeds", () => {
    expect(pickVariantIndex("a")).not.toBe(pickVariantIndex("b"));
  });
});
