import { describe, expect, test } from "vitest";
import {
  createSyntheticToolCallId,
  formatToolArgs,
  formatToolCallName,
} from "../src/agent/tool-format.ts";

describe("formatToolArgs", () => {
  test("formats object input as key=value pairs", () => {
    expect(formatToolArgs({ path: "README.md", limit: 5 })).toBe(
      'path="README.md", limit=5',
    );
  });

  test("parses stringified JSON input", () => {
    expect(formatToolArgs('{"a":1}')).toBe("a=1");
  });

  test("handles array, null, and undefined input", () => {
    expect(formatToolArgs(["a", 1])).toBe('"a", 1');
    expect(formatToolArgs(null)).toBe("");
    expect(formatToolArgs(undefined)).toBe("");
  });
});

describe("formatToolCallName", () => {
  test("maps execute to Execute and leaves other names as-is", () => {
    expect(formatToolCallName("execute")).toBe("Execute");
    expect(formatToolCallName("Read")).toBe("Read");
  });
});

describe("createSyntheticToolCallId", () => {
  test("derives a stable id from name and input", () => {
    expect(createSyntheticToolCallId("Read", { path: "a" })).toBe(
      'Read:{"path":"a"}',
    );
  });
});
