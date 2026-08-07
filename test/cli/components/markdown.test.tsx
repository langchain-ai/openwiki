import React from "react";
import { render } from "ink-testing-library";
import { marked } from "marked";
import { describe, expect, test } from "vitest";
import {
  MarkdownText,
  renderPlainTable,
} from "../../../src/cli/components/markdown.tsx";
import { stripAnsi as plain } from "./ansi.ts";

describe("MarkdownText", () => {
  test("renders paragraph text and list items", () => {
    const { lastFrame } = render(
      <MarkdownText markdown={"A paragraph.\n\n- one\n- two"} />,
    );

    const frame = plain(lastFrame());
    expect(frame).toContain("A paragraph.");
    expect(frame).toContain("- one");
    expect(frame).toContain("- two");
  });

  test("renders bold and code-span content", () => {
    const { lastFrame } = render(
      <MarkdownText markdown={"This is **bold** and `code`."} />,
    );

    const frame = plain(lastFrame());
    expect(frame).toContain("bold");
    expect(frame).toContain("code");
  });

  test("renders an ordered list with numeric markers", () => {
    const { lastFrame } = render(
      <MarkdownText markdown={"1. first\n2. second"} />,
    );

    const frame = plain(lastFrame());
    expect(frame).toContain("1. first");
    expect(frame).toContain("2. second");
  });

  test("strips raw HTML tags so no markup reaches the terminal", () => {
    const { lastFrame } = render(
      <MarkdownText markdown={"before <script>alert(1)</script> after"} />,
    );

    const frame = plain(lastFrame());
    expect(frame).not.toContain("<script>");
    expect(frame).not.toContain("</script>");
    expect(frame).not.toContain("<");
    expect(frame).not.toContain(">");
  });

  test("renders <u> wrapped content as its inner text without the tags", () => {
    const { lastFrame } = render(
      <MarkdownText markdown={"<u>underlined</u>"} />,
    );

    const frame = plain(lastFrame());
    expect(frame).toContain("underlined");
    expect(frame).not.toContain("<u>");
  });
});

describe("renderPlainTable", () => {
  test("flattens a table token into pipe-delimited rows", () => {
    const [token] = marked.lexer("| A | B |\n| - | - |\n| 1 | 2 |", {
      async: false,
      gfm: true,
    });

    // The lexer emits a single table token for this input.
    expect(token.type).toBe("table");
    const rendered = renderPlainTable(token as never);
    expect(rendered).toContain("A | B");
    expect(rendered).toContain("1 | 2");
  });
});
