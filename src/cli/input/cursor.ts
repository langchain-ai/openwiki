import type { Key } from "ink";
import type { ChatInputState } from "./types.js";

/**
 * Moves the caret by `offset` characters, clamped to the bounds of the value.
 */
export function moveInputCursor(
  state: ChatInputState,
  offset: number,
): ChatInputState {
  return {
    ...state,
    cursorPosition: clampCursorPosition(
      state.cursorPosition + offset,
      state.value,
    ),
  };
}

/**
 * Deletes the character immediately before the caret (backspace), leaving the
 * caret one position to the left.
 */
export function deleteBeforeInputCursor(state: ChatInputState): ChatInputState {
  if (state.cursorPosition === 0) {
    return state;
  }

  return {
    cursorPosition: state.cursorPosition - 1,
    value: `${state.value.slice(0, state.cursorPosition - 1)}${state.value.slice(
      state.cursorPosition,
    )}`,
  };
}

/**
 * Deletes the character at the caret (forward delete), leaving the caret in
 * place.
 */
export function deleteAtInputCursor(state: ChatInputState): ChatInputState {
  if (state.cursorPosition >= state.value.length) {
    return state;
  }

  return {
    ...state,
    value: `${state.value.slice(0, state.cursorPosition)}${state.value.slice(
      state.cursorPosition + 1,
    )}`,
  };
}

/**
 * Applies a raw terminal input chunk to the input state, interpreting embedded
 * ANSI escapes for cursor movement (left/right), forward delete, and backspace,
 * ignoring vertical-arrow escapes, and inserting any remaining printable
 * characters while dropping control characters.
 */
export function applyRawInputValue(
  state: ChatInputState,
  inputValue: string,
): ChatInputState {
  let nextState = state;

  for (let index = 0; index < inputValue.length; index += 1) {
    if (inputValue.startsWith("\u001b[D", index)) {
      nextState = moveInputCursor(nextState, -1);
      index += 2;
      continue;
    }

    if (inputValue.startsWith("\u001b[C", index)) {
      nextState = moveInputCursor(nextState, 1);
      index += 2;
      continue;
    }

    if (inputValue.startsWith("\u001b[3~", index)) {
      nextState = deleteAtInputCursor(nextState);
      index += 3;
      continue;
    }

    if (
      inputValue.startsWith("\u007f", index) ||
      inputValue.startsWith("\b", index)
    ) {
      nextState = deleteBeforeInputCursor(nextState);
      continue;
    }

    if (
      inputValue.startsWith("\u001b[A", index) ||
      inputValue.startsWith("\u001b[B", index)
    ) {
      index += 2;
      continue;
    }

    const character = inputValue[index];

    if (isControlCharacter(character)) {
      continue;
    }

    nextState = insertAtInputCursor(nextState, character);
  }

  return nextState;
}

/**
 * Inserts `character` at the caret and advances the caret past it.
 */
export function insertAtInputCursor(
  state: ChatInputState,
  character: string,
): ChatInputState {
  return {
    cursorPosition: state.cursorPosition + character.length,
    value: `${state.value.slice(0, state.cursorPosition)}${character}${state.value.slice(
      state.cursorPosition,
    )}`,
  };
}

/**
 * Clamps a caret position into `[0, value.length]`.
 */
export function clampCursorPosition(position: number, value: string): number {
  return Math.max(0, Math.min(value.length, position));
}

/**
 * Reports whether `character` is a C0 control character (code point below 32),
 * so raw input parsing can drop it rather than insert it.
 */
export function isControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);

  return codePoint !== undefined && codePoint < 32;
}

/**
 * Reports whether a raw input chunk is a bare backspace/delete keystroke.
 */
export function isRawBackspaceInput(inputValue: string): boolean {
  return inputValue === "\u007f" || inputValue === "\b";
}

/**
 * Reports whether a keystroke is Escape, from either the parsed `key` flag or a
 * raw ESC input byte.
 */
export function isEscapeInput(inputValue: string, key: Key): boolean {
  return key.escape || inputValue === "\u001b";
}
