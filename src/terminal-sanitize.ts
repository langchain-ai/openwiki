/**
 * Strip terminal control sequences from untrusted text before it is rendered
 * to a developer's terminal (for example through Ink).
 *
 * Preserves newline (`\n`) and tab (`\t`). Removes ESC/CSI/OSC/DCS-family
 * sequences, BEL, CR, other C0 controls, DEL, and C1 controls.
 */
export function stripUnsafeTerminalSequences(value: string): string {
  let remaining = value;
  let sanitized = "";

  while (remaining.length > 0) {
    const escapeIndex = findControlIntroducerIndex(remaining);

    if (escapeIndex === -1) {
      sanitized += stripResidualControls(remaining);
      break;
    }

    sanitized += stripResidualControls(remaining.slice(0, escapeIndex));
    const sequenceStart = remaining.slice(escapeIndex);
    const consumed = consumeControlSequence(sequenceStart);
    remaining = sequenceStart.slice(consumed);
  }

  return sanitized;
}

function findControlIntroducerIndex(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);

    if (
      codePoint === 0x1b ||
      codePoint === 0x9b ||
      codePoint === 0x9d ||
      codePoint === 0x90 ||
      codePoint === 0x98 ||
      codePoint === 0x9e ||
      codePoint === 0x9f
    ) {
      return index;
    }
  }

  return -1;
}

function stripResidualControls(value: string): string {
  let sanitized = "";

  for (const character of value) {
    const codePoint = character.codePointAt(0);

    if (codePoint === undefined) {
      continue;
    }

    if (codePoint === 9 || codePoint === 10) {
      sanitized += character;
      continue;
    }

    if (
      codePoint <= 31 ||
      codePoint === 127 ||
      (codePoint >= 128 && codePoint <= 159)
    ) {
      continue;
    }

    sanitized += character;
  }

  return sanitized;
}

function consumeControlSequence(value: string): number {
  if (value.length === 0) {
    return 0;
  }

  const firstCodePoint = value.codePointAt(0);

  if (firstCodePoint === 0x9b) {
    return 1 + consumeCsiParameters(value.slice(1));
  }

  if (firstCodePoint === 0x9d) {
    return 1 + consumeOscPayload(value.slice(1));
  }

  if (
    firstCodePoint === 0x90 ||
    firstCodePoint === 0x98 ||
    firstCodePoint === 0x9e ||
    firstCodePoint === 0x9f
  ) {
    return 1 + consumeStringTerminatedPayload(value.slice(1));
  }

  if (firstCodePoint !== 0x1b) {
    return 1;
  }

  if (value.length === 1) {
    return 1;
  }

  const introducer = value[1];

  if (introducer === "[") {
    return 2 + consumeCsiParameters(value.slice(2));
  }

  if (introducer === "]") {
    return 2 + consumeOscPayload(value.slice(2));
  }

  if (
    introducer === "P" ||
    introducer === "X" ||
    introducer === "^" ||
    introducer === "_"
  ) {
    return 2 + consumeStringTerminatedPayload(value.slice(2));
  }

  // Two-character escape (or lone ESC when nothing follows to form a longer sequence).
  return 2;
}

function consumeCsiParameters(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);

    if (codePoint === undefined) {
      return index;
    }

    if (codePoint >= 0x40 && codePoint <= 0x7e) {
      return index + 1;
    }
  }

  return value.length;
}

function consumeOscPayload(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);

    if (codePoint === 0x07) {
      return index + 1;
    }

    if (codePoint === 0x1b && value[index + 1] === "\\") {
      return index + 2;
    }
  }

  return value.length;
}

function consumeStringTerminatedPayload(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    if (value.codePointAt(index) === 0x1b && value[index + 1] === "\\") {
      return index + 2;
    }
  }

  return value.length;
}
