import { describe, expect, test } from "vitest";
import {
  countToolTargets,
  parseToolInput,
} from "../../../src/cli/run-log/tool-input.ts";

describe("parseToolInput", () => {
  test("parses JSON and preserves other values", () => {
    expect(parseToolInput('{"path":"a.ts"}')).toEqual({ path: "a.ts" });
    expect(parseToolInput("not json")).toBe("not json");
    expect(parseToolInput({ path: "a.ts" })).toEqual({ path: "a.ts" });
  });
});

describe("countToolTargets", () => {
  test("counts direct, keyed, and stringified arrays", () => {
    expect(countToolTargets(["a", "b"], ["paths"])).toBe(2);
    expect(countToolTargets({ paths: ["a", "b", "c"] }, ["paths"])).toBe(3);
    expect(countToolTargets('{"tasks":[{},{}]}', ["tasks"])).toBe(2);
  });

  test("defaults to one target", () => {
    expect(countToolTargets({}, ["paths"])).toBe(1);
  });
});
