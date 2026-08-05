import { describe, expect, test } from "vitest";
import { stripUnsafeTerminalSequences } from "../src/terminal-sanitize.ts";

describe("stripUnsafeTerminalSequences", () => {
  test("preserves ordinary text, newlines, and tabs", () => {
    const input = "hello\n\tworld";
    expect(stripUnsafeTerminalSequences(input)).toBe(input);
  });

  test("removes OSC 52 clipboard sequences terminated with BEL", () => {
    const payload = "SGVsbG8=";
    const input = `before\u001b]52;c;${payload}\u0007after`;
    expect(stripUnsafeTerminalSequences(input)).toBe("beforeafter");
    expect(stripUnsafeTerminalSequences(input)).not.toContain("\u001b");
    expect(stripUnsafeTerminalSequences(input)).not.toContain("\u0007");
    expect(stripUnsafeTerminalSequences(input)).not.toContain(payload);
  });

  test("removes OSC 52 sequences terminated with ST", () => {
    const input = "before\u001b]52;c;SGVsbG8=\u001b\\after";
    expect(stripUnsafeTerminalSequences(input)).toBe("beforeafter");
  });

  test("removes OSC 8 hyperlink sequences", () => {
    const input =
      "click \u001b]8;;https://evil.example\u0007here\u001b]8;;\u0007 please";
    expect(stripUnsafeTerminalSequences(input)).toBe("click here please");
  });

  test("removes CSI clear and cursor sequences", () => {
    const input = "keep\u001b[2J\u001b[H\u001b[0mmore";
    expect(stripUnsafeTerminalSequences(input)).toBe("keepmore");
  });

  test("removes BEL and carriage return", () => {
    const input = "a\u0007b\rc";
    expect(stripUnsafeTerminalSequences(input)).toBe("abc");
  });

  test("removes C1 controls including 8-bit CSI and OSC introducers", () => {
    const input = `safe\u009b2J\u009d52;c;QQ==\u0007text`;
    expect(stripUnsafeTerminalSequences(input)).toBe("safetext");
  });

  test("strips incomplete OSC sequences at end of input", () => {
    const input = "prefix\u001b]52;c;partial";
    expect(stripUnsafeTerminalSequences(input)).toBe("prefix");
  });

  test("sanitizes sequences inside markdown code fences and inline code", () => {
    const fenced = ["```", "echo hi\u001b]52;c;QQ==\u0007", "```"].join("\n");
    const inline = "use `x\u001b[2Jy` carefully";

    expect(stripUnsafeTerminalSequences(fenced)).toBe(
      ["```", "echo hi", "```"].join("\n"),
    );
    expect(stripUnsafeTerminalSequences(inline)).toBe("use `xy` carefully");
  });

  test("keeps printable unicode outside the control ranges", () => {
    const input = "café 你好 🙂";
    expect(stripUnsafeTerminalSequences(input)).toBe(input);
  });
});
