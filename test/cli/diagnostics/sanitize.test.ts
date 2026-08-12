import { describe, expect, test } from "vitest";
import {
  sanitizeHeaderValue,
  stripControlCharacters,
} from "../../../src/cli/diagnostics/sanitize.ts";

// Control characters built by code point so the source stays pure ASCII.
const BELL = String.fromCharCode(0x07); // C0
const TAB = String.fromCharCode(0x09); // C0
const DEL = String.fromCharCode(0x7f); // start of the 127-159 band
const C1 = String.fromCharCode(0x85); // inside the 127-159 band
const ESC = String.fromCharCode(0x1b); // ANSI escape introducer
const NEWLINE = String.fromCharCode(0x0a);

describe("stripControlCharacters", () => {
  test("leaves printable text untouched", () => {
    expect(stripControlCharacters("hello world")).toBe("hello world");
  });

  test("replaces C0 control characters with spaces", () => {
    expect(stripControlCharacters(`a${BELL}b${TAB}c`)).toBe("a b c");
  });

  test("replaces DEL and C1 control characters (127-159) with spaces", () => {
    expect(stripControlCharacters(`a${DEL}b${C1}c`)).toBe("a b c");
  });

  test("neutralizes ANSI escape sequences", () => {
    // ESC becomes a space, so the sequence can no longer move the cursor or
    // recolor the terminal.
    expect(stripControlCharacters(`${ESC}[31mred${ESC}[0m`)).toBe(
      " [31mred [0m",
    );
  });
});

describe("sanitizeHeaderValue", () => {
  test("folds whitespace runs to single spaces and trims", () => {
    expect(sanitizeHeaderValue(`  a${TAB}${TAB} b   c  `)).toBe("a b c");
  });

  test("collapses newlines to spaces", () => {
    expect(sanitizeHeaderValue(`line1${NEWLINE}line2`)).toBe("line1 line2");
  });

  test("truncates past maxLength with an ellipsis", () => {
    const result = sanitizeHeaderValue("x".repeat(100), 10);
    expect(result).toBe(`${"x".repeat(7)}...`);
    expect(result).toHaveLength(10);
  });

  test("returns the value unchanged when within maxLength", () => {
    expect(sanitizeHeaderValue("short", 80)).toBe("short");
  });

  test("strips control characters before measuring length", () => {
    expect(sanitizeHeaderValue(`a${BELL}b`)).toBe("a b");
  });
});
