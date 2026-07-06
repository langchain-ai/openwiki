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

  test("removes an unterminated trailing tag start", () => {
    // The reported gap: a single-pass /<[^>]*>/ leaves "<script" (no closing >).
    expect(stripHtmlTags("text <script")).toBe("text ");
    expect(stripHtmlTags("<script")).toBe("");
    expect(stripHtmlTags("ok <div class=")).toBe("ok ");
  });

  test("does not reintroduce a tag from surrounding text", () => {
    expect(stripHtmlTags("<scr<script>ipt>")).not.toContain("<script");
    expect(stripHtmlTags("<<script>>")).not.toContain("<script");
  });

  test("leaves plain text untouched", () => {
    expect(stripHtmlTags("just plain text")).toBe("just plain text");
    expect(stripHtmlTags("")).toBe("");
  });
});
