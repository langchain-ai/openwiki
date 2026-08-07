import { describe, expect, test } from "vitest";
import { isDiagnosticValue, isRecord } from "../../src/cli/guards.ts";

describe("isRecord", () => {
  test("accepts plain objects and arrays", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    // Arrays are objects; the guard is deliberately permissive here.
    expect(isRecord([])).toBe(true);
  });

  test("rejects null and primitives", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord("s")).toBe(false);
    expect(isRecord(1)).toBe(false);
    expect(isRecord(true)).toBe(false);
  });
});

describe("isDiagnosticValue", () => {
  test("accepts string, number, and boolean scalars", () => {
    expect(isDiagnosticValue("s")).toBe(true);
    expect(isDiagnosticValue(0)).toBe(true);
    expect(isDiagnosticValue(false)).toBe(true);
  });

  test("rejects objects, arrays, and nullish", () => {
    expect(isDiagnosticValue({})).toBe(false);
    expect(isDiagnosticValue([])).toBe(false);
    expect(isDiagnosticValue(null)).toBe(false);
    expect(isDiagnosticValue(undefined)).toBe(false);
  });
});
