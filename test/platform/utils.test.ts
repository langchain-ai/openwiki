import { describe, expect, test } from "vitest";
import {
  stripHtmlTags,
  stripTerminalControlSequences,
} from "../../src/platform/utils.ts";

describe("stripHtmlTags", () => {
  test("removes a complete tag pair", () => {
    expect(stripHtmlTags("<div>hello</div>")).toBe("hello");
  });

  test("removes adjacent and nested tags", () => {
    expect(stripHtmlTags("<b><i>hi</i></b>")).toBe("hi");
    expect(stripHtmlTags("a<br/>b<hr>c")).toBe("abc");
  });

  test("removes HTML comments", () => {
    expect(stripHtmlTags("before<!-- secret -->after")).toBe("beforeafter");
  });

  test("strips an unterminated tag fragment, leaving no angle brackets", () => {
    expect(stripHtmlTags("text <script")).toBe("text script");
    expect(stripHtmlTags("<script")).toBe("script");
  });

  test("never leaves an angle bracket in the output", () => {
    for (const input of [
      "<div>hi</div>",
      "text <script",
      "<scr<script>ipt>",
      "<<script>>",
      "a < b > c",
    ]) {
      const output = stripHtmlTags(input);
      expect(output).not.toContain("<");
      expect(output).not.toContain(">");
    }
  });

  test("leaves plain text untouched", () => {
    expect(stripHtmlTags("just plain text")).toBe("just plain text");
    expect(stripHtmlTags("")).toBe("");
  });
});

describe("stripTerminalControlSequences", () => {
  test("removes OSC clipboard and hyperlink sequences", () => {
    const value =
      "before\u001b]52;c;SGVsbG8=\u0007middle\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007after";

    expect(stripTerminalControlSequences(value)).toBe("beforemiddlelinkafter");
  });

  test("removes CSI cursor/display controls and C1 controls", () => {
    const value = "a\u001b[2J\u001b[H\u0080b\u009cc";

    expect(stripTerminalControlSequences(value)).toBe("abc");
  });

  test("removes BEL, carriage returns, and other C0 controls but keeps Markdown whitespace", () => {
    expect(stripTerminalControlSequences("a\u0007\r\u0000b\tcode\nnext")).toBe(
      "ab\tcode\nnext",
    );
  });

  test("removes unterminated OSC and DCS payloads", () => {
    expect(stripTerminalControlSequences("safe\u001b]52;c;secret")).toBe(
      "safe",
    );
    expect(stripTerminalControlSequences("safe\u001bP1;2;secret")).toBe("safe");
  });
});
