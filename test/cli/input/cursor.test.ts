import type { Key } from "ink";
import { describe, expect, test } from "vitest";
import {
  applyRawInputValue,
  clampCursorPosition,
  deleteAtInputCursor,
  deleteBeforeInputCursor,
  insertAtInputCursor,
  isControlCharacter,
  isEscapeInput,
  isRawBackspaceInput,
  moveInputCursor,
} from "../../../src/cli/input/cursor.ts";
import type { ChatInputState } from "../../../src/cli/input/types.ts";

// Terminal control bytes built by code point so the source stays pure ASCII.
const ESC = String.fromCharCode(0x1b);
const DEL = String.fromCharCode(0x7f);
const BACKSPACE = String.fromCharCode(0x08);

/**
 * Builds a fully-populated ink Key with every flag false except the overrides.
 */
function makeKey(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...overrides,
  };
}

describe("moveInputCursor", () => {
  test("moves the caret and clamps to the value bounds", () => {
    const state: ChatInputState = { cursorPosition: 2, value: "abcd" };

    expect(moveInputCursor(state, 1).cursorPosition).toBe(3);
    expect(moveInputCursor(state, -5).cursorPosition).toBe(0);
    expect(moveInputCursor(state, 10).cursorPosition).toBe(4);
  });
});

describe("deleteBeforeInputCursor", () => {
  test("returns the state unchanged at the start of the value", () => {
    const state: ChatInputState = { cursorPosition: 0, value: "abc" };
    expect(deleteBeforeInputCursor(state)).toBe(state);
  });

  test("deletes the character before the caret and steps left", () => {
    const result = deleteBeforeInputCursor({ cursorPosition: 2, value: "abc" });
    expect(result).toEqual({ cursorPosition: 1, value: "ac" });
  });
});

describe("deleteAtInputCursor", () => {
  test("returns the state unchanged at the end of the value", () => {
    const state: ChatInputState = { cursorPosition: 3, value: "abc" };
    expect(deleteAtInputCursor(state)).toBe(state);
  });

  test("deletes the character at the caret and keeps the caret in place", () => {
    const result = deleteAtInputCursor({ cursorPosition: 1, value: "abc" });
    expect(result).toEqual({ cursorPosition: 1, value: "ac" });
  });
});

describe("insertAtInputCursor", () => {
  test("inserts at the caret and advances past the inserted text", () => {
    const result = insertAtInputCursor({ cursorPosition: 1, value: "ac" }, "b");
    expect(result).toEqual({ cursorPosition: 2, value: "abc" });
  });
});

describe("clampCursorPosition", () => {
  test("clamps into the closed range [0, value.length]", () => {
    expect(clampCursorPosition(-1, "abc")).toBe(0);
    expect(clampCursorPosition(2, "abc")).toBe(2);
    expect(clampCursorPosition(9, "abc")).toBe(3);
  });
});

describe("isControlCharacter", () => {
  test("is true below code point 32 and false for printable characters", () => {
    expect(isControlCharacter(BACKSPACE)).toBe(true);
    expect(isControlCharacter(ESC)).toBe(true);
    expect(isControlCharacter("a")).toBe(false);
    expect(isControlCharacter(" ")).toBe(false);
  });
});

describe("isRawBackspaceInput", () => {
  test("recognizes bare DEL and backspace bytes only", () => {
    expect(isRawBackspaceInput(DEL)).toBe(true);
    expect(isRawBackspaceInput(BACKSPACE)).toBe(true);
    expect(isRawBackspaceInput("a")).toBe(false);
    expect(isRawBackspaceInput(`${DEL}x`)).toBe(false);
  });
});

describe("isEscapeInput", () => {
  test("is true from the parsed escape flag or a raw ESC byte", () => {
    expect(isEscapeInput("", makeKey({ escape: true }))).toBe(true);
    expect(isEscapeInput(ESC, makeKey())).toBe(true);
    expect(isEscapeInput("a", makeKey())).toBe(false);
  });
});

describe("applyRawInputValue", () => {
  const empty: ChatInputState = { cursorPosition: 0, value: "" };

  test("inserts printable characters and advances the caret", () => {
    expect(applyRawInputValue(empty, "hello")).toEqual({
      cursorPosition: 5,
      value: "hello",
    });
  });

  test("drops standalone control characters", () => {
    expect(applyRawInputValue(empty, `a${String.fromCharCode(0x01)}b`)).toEqual(
      {
        cursorPosition: 2,
        value: "ab",
      },
    );
  });

  test("moves the caret left and right on ANSI arrow escapes", () => {
    const state: ChatInputState = { cursorPosition: 2, value: "abc" };
    expect(applyRawInputValue(state, `${ESC}[D`).cursorPosition).toBe(1);
    expect(applyRawInputValue(state, `${ESC}[C`).cursorPosition).toBe(3);
  });

  test("ignores vertical arrow escapes", () => {
    const state: ChatInputState = { cursorPosition: 1, value: "abc" };
    expect(applyRawInputValue(state, `${ESC}[A`)).toEqual(state);
    expect(applyRawInputValue(state, `${ESC}[B`)).toEqual(state);
  });

  test("forward-deletes on the ANSI delete escape", () => {
    const result = applyRawInputValue(
      { cursorPosition: 1, value: "abc" },
      `${ESC}[3~`,
    );
    expect(result).toEqual({ cursorPosition: 1, value: "ac" });
  });

  test("backspaces on DEL and on the backspace byte", () => {
    const state: ChatInputState = { cursorPosition: 2, value: "abc" };
    expect(applyRawInputValue(state, DEL)).toEqual({
      cursorPosition: 1,
      value: "ac",
    });
    expect(applyRawInputValue(state, BACKSPACE)).toEqual({
      cursorPosition: 1,
      value: "ac",
    });
  });

  test("applies a mixed escape-and-text chunk left to right", () => {
    // Insert "ab", move left once, then insert "X" between a and b.
    const result = applyRawInputValue(empty, `ab${ESC}[DX`);
    expect(result).toEqual({ cursorPosition: 2, value: "aXb" });
  });
});
