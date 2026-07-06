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

  test("does not leave a tag reassembled from surrounding brackets", () => {
    expect(stripHtmlTags("<scr<script>ipt>")).not.toContain("<script");
    expect(stripHtmlTags("<<script>>")).not.toContain("<script");
  });

  test("leaves an unterminated tag fragment as literal text", () => {
    // No closing ">", so it isn't a tag; harmless as terminal text.
    expect(stripHtmlTags("text <script")).toBe("text <script");
  });

  test("leaves plain text untouched", () => {
    expect(stripHtmlTags("just plain text")).toBe("just plain text");
    expect(stripHtmlTags("")).toBe("");
  });
});
