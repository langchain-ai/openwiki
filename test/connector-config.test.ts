import { describe, expect, test } from "vitest";
import { normalizeStringArray } from "../src/connectors/config.ts";

describe("normalizeStringArray", () => {
  test("keeps non-empty strings and trims each", () => {
    expect(normalizeStringArray(["  a ", "b", "  c"])).toEqual(["a", "b", "c"]);
  });

  test("drops blank and whitespace-only entries", () => {
    expect(normalizeStringArray(["a", "", "   ", "b"])).toEqual(["a", "b"]);
  });

  test("drops non-string entries", () => {
    expect(normalizeStringArray(["a", 1, null, undefined, {}, "b"])).toEqual([
      "a",
      "b",
    ]);
  });

  test("returns an empty array for a non-array value", () => {
    expect(normalizeStringArray("a,b,c")).toEqual([]);
    expect(normalizeStringArray(undefined)).toEqual([]);
    expect(normalizeStringArray(null)).toEqual([]);
    expect(normalizeStringArray(42)).toEqual([]);
  });

  test("returns an empty array for an empty array", () => {
    expect(normalizeStringArray([])).toEqual([]);
  });
});
