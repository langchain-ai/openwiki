import { lexer, type Token, type Tokens } from "marked";
import { splitFrontmatter } from "../../../okf/frontmatter.js";
import { normalizeWikiPagePath } from "./paths.js";

/**
 * Markdown-derived section boundaries, independent of authored sidecar state.
 */
export interface MarkdownSection {
  /**
   * Canonical wiki-relative page and encoded heading ancestry.
   */
  location: string;

  /**
   * Heading text, or an empty string for a page's unheaded introduction.
   */
  title: string;

  /**
   * Heading depth, with zero reserved for an unheaded introduction.
   */
  depth: number;

  /**
   * Original Markdown heading, including its trailing newline; empty for a preamble.
   */
  heading: string;

  /**
   * Direct section content without its heading or descendant sections.
   */
  body: string;
}

/**
 * Encodes a heading component while preserving readable case and punctuation.
 *
 * Whitespace is removed; literal `#` and `%` are percent-encoded so they cannot
 * become hierarchy delimiters. Identical resulting paths remain ambiguous and
 * must be corrected by the author rather than assigned positional identities.
 *
 * @param heading - Markdown heading text returned by the lexer.
 * @returns Canonical component for a section location.
 */
export function encodeSectionHeading(heading: string): string {
  return encodeURIComponent(heading.replace(/\s+/gu, ""));
}

/**
 * Extracts top-level Markdown headings and their direct body text.
 *
 * The Markdown lexer excludes heading-like text inside code, HTML, blockquotes,
 * and lists. Setext headings are supported. Frontmatter is never passage text.
 * Content before the first heading uses the page path alone as its location.
 *
 * @param page - Generated-page path accepted by the code brain.
 * @param markdown - Complete authored Markdown, including any frontmatter.
 * @returns Sections in document order, with line endings normalized to LF.
 */
export function parseMarkdownSections(
  page: string,
  markdown: string,
): MarkdownSection[] {
  const relativePage = normalizeWikiPagePath(page).slice("/openwiki/".length);
  const body = splitFrontmatter(markdown.replace(/\r\n?/gu, "\n")).body;
  const sections: MarkdownSection[] = [];
  const ancestors: Array<{ depth: number; component: string }> = [];
  let current: MarkdownSection = {
    location: relativePage,
    title: "",
    depth: 0,
    heading: "",
    body: "",
  };

  for (const token of lexer(body)) {
    if (isHeading(token)) {
      if (current.depth > 0 || current.body.trim()) sections.push(current);
      while (ancestors.length && ancestors.at(-1)!.depth >= token.depth) {
        ancestors.pop();
      }
      ancestors.push({
        depth: token.depth,
        component: encodeSectionHeading(token.text),
      });
      current = {
        location: [
          relativePage,
          ...ancestors.map(({ component }) => component),
        ].join("#"),
        title: token.text,
        depth: token.depth,
        heading: token.raw,
        body: "",
      };
    } else {
      current.body += token.raw;
    }
  }
  if (current.depth > 0 || current.body.trim()) sections.push(current);
  return sections;
}

/**
 * Narrows a lexer token despite Marked's open-ended extension token type.
 *
 * @param token - Top-level token emitted by the Markdown lexer.
 * @returns Whether the token carries a heading's depth and text.
 */
function isHeading(token: Token): token is Tokens.Heading {
  return (
    token.type === "heading" &&
    typeof token.depth === "number" &&
    typeof token.text === "string"
  );
}
