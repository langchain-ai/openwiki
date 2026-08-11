import React from "react";
import { Box, Text } from "ink";
import { marked, type Token, type Tokens } from "marked";
import {
  stripHtmlTags,
  stripTerminalControlSequences,
} from "../../platform/utils.js";

/**
 * Renders a markdown string as a column of Ink blocks by lexing it with marked
 * (GFM, synchronous) and delegating each top-level token to MarkdownBlock.
 */
export function MarkdownText({ markdown }: { markdown: string }) {
  const tokens = marked.lexer(stripTerminalControlSequences(markdown), {
    async: false,
    gfm: true,
  });

  return (
    <Box flexDirection="column">
      {tokens.map((token, index) => (
        <MarkdownBlock
          index={index}
          key={`${token.type}-${index}`}
          token={token}
        />
      ))}
    </Box>
  );
}

/**
 * Renders a single block-level markdown token (paragraph, heading, list, code,
 * blockquote, table, html, or text), returning null for structural whitespace.
 */
export function MarkdownBlock({
  index,
  token,
}: {
  index: number;
  token: Token;
}) {
  if (token.type === "space" || token.type === "def" || token.type === "hr") {
    return null;
  }

  if (token.type === "paragraph") {
    return (
      <Text wrap="wrap">
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "heading") {
    return (
      <Text wrap="wrap">
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "list") {
    return (
      <Box flexDirection="column">
        {(token as Tokens.List).items.map((item, itemIndex) => (
          <Text key={`${index}-${itemIndex}`} wrap="wrap">
            <Text color="gray">
              {(token as Tokens.List).ordered
                ? `${Number((token as Tokens.List).start || 1) + itemIndex}. `
                : "- "}
            </Text>
            <InlineMarkdown tokens={getTokenChildren(item)} />
          </Text>
        ))}
      </Box>
    );
  }

  if (token.type === "code") {
    return <Text color="gray">{token.text}</Text>;
  }

  if (token.type === "blockquote") {
    return (
      <Text wrap="wrap">
        <Text color="gray">| </Text>
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "table") {
    return <Text color="gray">{renderPlainTable(token as Tokens.Table)}</Text>;
  }

  if (token.type === "html") {
    return <Text wrap="wrap">{renderHtmlToken(token)}</Text>;
  }

  if (token.type === "text") {
    return (
      <Text wrap="wrap">
        <InlineMarkdown tokens={token.tokens ?? [token]} />
      </Text>
    );
  }

  return <Text wrap="wrap">{token.raw}</Text>;
}

/**
 * Renders a sequence of inline markdown tokens.
 */
export function InlineMarkdown({ tokens }: { tokens: Token[] }) {
  return (
    <>
      {tokens.map((token, index) => (
        <InlineMarkdownToken key={`${token.type}-${index}`} token={token} />
      ))}
    </>
  );
}

/**
 * Renders a single inline markdown token (text, strong, em, link, codespan,
 * br, del, or html), recursing into children for the styled variants.
 */
export function InlineMarkdownToken({ token }: { token: Token }) {
  if (token.type === "text" || token.type === "escape") {
    return <>{token.text}</>;
  }

  if (token.type === "strong") {
    return (
      <Text bold>
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "em") {
    return (
      <Text italic>
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "link") {
    return (
      <Text underline>
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "codespan") {
    return <Text color="gray">{token.text}</Text>;
  }

  if (token.type === "br") {
    return <>{"\n"}</>;
  }

  if (token.type === "del") {
    return (
      <Text strikethrough>
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "html") {
    return <>{renderHtmlToken(token)}</>;
  }

  if ("tokens" in token && Array.isArray(token.tokens)) {
    return <InlineMarkdown tokens={token.tokens} />;
  }

  return <>{token.raw}</>;
}

/**
 * Returns a token's child tokens, or an empty array when it has none.
 */
export function getTokenChildren(token: Token): Token[] {
  return "tokens" in token && Array.isArray(token.tokens) ? token.tokens : [];
}

/**
 * Flattens a markdown table token into pipe-delimited plain-text rows.
 */
export function renderPlainTable(token: Tokens.Table): string {
  const header = token.header.map((cell) => cell.text).join(" | ");
  const rows = token.rows.map((row) =>
    row.map((cell) => cell.text).join(" | "),
  );

  return [header, ...rows].filter(Boolean).join("\n");
}

/**
 * Renders an inline HTML token as underlined text for a `<u>` wrapper, otherwise
 * strips tags to plain text so no raw HTML reaches the terminal.
 */
export function renderHtmlToken(token: Token): React.ReactNode {
  const text =
    "text" in token && typeof token.text === "string" ? token.text : token.raw;
  const underlineMatch = text.match(/^<u>(.*)<\/u>$/isu);

  if (underlineMatch) {
    return <Text underline>{underlineMatch[1]}</Text>;
  }

  return stripHtmlTags(text);
}
