import React from "react";
import { render } from "ink-testing-library";
import { marked, type Token } from "marked";
import { describe, expect, test } from "vitest";
import {
  getTokenChildren,
  MarkdownText,
  renderHtmlToken,
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

describe("MarkdownText inline and block variants", () => {
  test("renders a link's text underlined without the URL markup", () => {
    const { lastFrame } = render(
      <MarkdownText markdown={"See [LangChain](https://example.com/x)."} />,
    );
    const frame = plain(lastFrame());

    expect(frame).toContain("LangChain");
    expect(frame).not.toContain("https://example.com/x");
    expect(frame).not.toContain("](");
  });

  test("renders italic and strikethrough inline content", () => {
    const { lastFrame } = render(
      <MarkdownText markdown={"This is *italic* and ~~gone~~."} />,
    );
    const frame = plain(lastFrame());

    expect(frame).toContain("italic");
    expect(frame).toContain("gone");
  });

  test("keeps both sides of a hard line break", () => {
    const { lastFrame } = render(
      <MarkdownText markdown={"line one  \nline two"} />,
    );
    const frame = plain(lastFrame());

    expect(frame).toContain("line one");
    expect(frame).toContain("line two");
  });

  test("renders a blockquote with a gutter marker", () => {
    const { lastFrame } = render(<MarkdownText markdown={"> quoted words"} />);
    const frame = plain(lastFrame());

    expect(frame).toContain("quoted words");
    expect(frame).toContain("|");
  });

  test("renders a fenced code block verbatim", () => {
    const { lastFrame } = render(
      <MarkdownText markdown={"```\nconst x = 1;\n```"} />,
    );
    expect(plain(lastFrame())).toContain("const x = 1;");
  });

  test("renders a table block through renderPlainTable", () => {
    const { lastFrame } = render(
      <MarkdownText markdown={"| A | B |\n| - | - |\n| 1 | 2 |"} />,
    );
    const frame = plain(lastFrame());

    expect(frame).toContain("A | B");
    expect(frame).toContain("1 | 2");
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

describe("renderHtmlToken", () => {
  test("renders a <u> wrapper as an underlined Ink element, not a string", () => {
    const node = renderHtmlToken({
      type: "html",
      raw: "<u>keep</u>",
      text: "<u>keep</u>",
    });

    // The underline branch returns a React element; the strip branch returns a
    // bare string. A non-string proves we took the underline path.
    expect(typeof node).not.toBe("string");
    const { lastFrame } = render(<>{node}</>);
    const frame = plain(lastFrame());
    expect(frame).toContain("keep");
    expect(frame).not.toContain("<u>");
  });

  test("strips any other HTML to inert text so no markup reaches the terminal", () => {
    const node = renderHtmlToken({
      type: "html",
      raw: "<b>bold</b>",
      text: "<b>bold</b>",
    });

    expect(typeof node).toBe("string");
    expect(node).toBe("bold");
    expect(node).not.toContain("<");
  });

  test("falls back to token.raw when the token carries no text field", () => {
    const node = renderHtmlToken({
      type: "html",
      raw: "<i>italic</i>",
    });

    expect(node).toBe("italic");
  });
});

describe("getTokenChildren", () => {
  test("returns the child tokens when present", () => {
    const child: Token = { type: "text", raw: "a", text: "a" };
    const parent = {
      type: "strong",
      raw: "**a**",
      text: "a",
      tokens: [child],
    } as unknown as Token;

    expect(getTokenChildren(parent)).toEqual([child]);
  });

  test("returns an empty array when the token has no children", () => {
    const leaf = { type: "text", raw: "a", text: "a" } as unknown as Token;

    expect(getTokenChildren(leaf)).toEqual([]);
  });
});
