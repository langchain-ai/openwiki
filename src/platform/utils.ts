/**
 * Removes HTML tags from a string and returns the remaining plain text.
 *
 * Well-formed tags are removed by stripping `<...>` spans repeatedly until the
 * string stops changing. Any leftover angle brackets are then removed individually,
 * so neither a complete nor a partial tag can survive.
 */
export function stripHtmlTags(input: string): string {
  let previous: string;
  let output = input;

  do {
    previous = output;
    output = output.replace(/<[^>]*>/gu, "");
  } while (output !== previous);

  return output.replace(/[<>]/gu, "");
}

/**
 * Removes terminal control protocols from untrusted text before rendering it.
 * Newlines and tabs remain useful Markdown whitespace; other C0/C1 controls
 * are discarded rather than passed to a terminal emulator.
 */
export function stripTerminalControlSequences(input: string): string {
  let output = "";

  for (let index = 0; index < input.length;) {
    const code = input.charCodeAt(index);

    if (code === 0x1b) {
      index = skipEscapeSequence(input, index + 1);
      continue;
    }

    if (code >= 0x80 && code <= 0x9f) {
      index = skipC1Sequence(input, index);
      continue;
    }

    if (code < 0x20 || code === 0x7f) {
      if (code === 0x09 || code === 0x0a) {
        output += input[index];
      }
      index += 1;
      continue;
    }

    output += input[index];
    index += 1;
  }

  return output;
}

function skipEscapeSequence(input: string, index: number): number {
  const introducer = input.charCodeAt(index);

  if (introducer === 0x5b) {
    return skipCsiSequence(input, index + 1);
  }

  if (introducer === 0x5d) {
    return skipStringSequence(input, index + 1);
  }

  // DCS, SOS, PM, and APC are ESC-prefixed string controls.
  if (
    introducer === 0x50 ||
    introducer === 0x58 ||
    introducer === 0x5e ||
    introducer === 0x5f
  ) {
    return skipStringSequence(input, index + 1);
  }

  // For a two-byte escape (for example, a charset select), discard the
  // sequence introducer and its final byte.
  return Math.min(input.length, index + 1);
}

function skipC1Sequence(input: string, index: number): number {
  const code = input.charCodeAt(index);

  if (code === 0x9b) {
    return skipCsiSequence(input, index + 1);
  }

  if (
    code === 0x9d ||
    code === 0x90 ||
    code === 0x98 ||
    code === 0x9e ||
    code === 0x9f
  ) {
    return skipStringSequence(input, index + 1);
  }

  return index + 1;
}

function skipCsiSequence(input: string, index: number): number {
  while (index < input.length) {
    const code = input.charCodeAt(index);
    index += 1;

    // CSI final bytes are in the range 0x40-0x7e.
    if (code >= 0x40 && code <= 0x7e) {
      break;
    }
  }

  return index;
}

function skipStringSequence(input: string, index: number): number {
  while (index < input.length) {
    const code = input.charCodeAt(index);

    if (code === 0x07 || code === 0x9c) {
      return index + 1;
    }

    if (code === 0x1b && input.charCodeAt(index + 1) === 0x5c) {
      return index + 2;
    }

    index += 1;
  }

  return index;
}
