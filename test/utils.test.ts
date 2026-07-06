import { describe, expect, test } from "vitest";
import { stripHtmlTags } from "../src/utils.ts";

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
