import { describe, expect, test } from "vitest";

import type { KnowledgeArtifact, KnowledgeDocument } from "../core/types.js";
import { DEFAULT_MAX_SECTION_CHARS, sectionArtifact } from "./documents.js";

/**
 * Build a minimal immutable artifact fixture from supplied documents.
 *
 * @param documents - Documents to include in the fixture.
 *
 * @returns A knowledge artifact suitable for sectioning tests.
 */
function artifact(documents: KnowledgeDocument[]): KnowledgeArtifact {
  return {
    checkpointId: "T0",
    snapshotDir: "/must-not-be-read",
    fingerprint: "fixture",
    documents,
  };
}

describe("sectionArtifact", () => {
  test("sorts Markdown documents and sections headings into stable identities", () => {
    const sections = sectionArtifact(
      artifact([
        { relativePath: "z.md", content: "# Zed\nLast.\n" },
        { relativePath: "ignored.json", content: '{"not":"markdown"}' },
        {
          relativePath: "a.md",
          content:
            "Preamble.\n\n# API\nIntro.\n## writeFile ##\nWrites.\n### Errors\nFails.\n# End\nDone.\n",
        },
      ]),
    );

    expect(sections.map((section) => section.id)).toEqual([
      "a.md::0000",
      "a.md::0001",
      "a.md::0002",
      "a.md::0003",
      "a.md::0004",
      "z.md::0000",
    ]);
    expect(sections.map((section) => section.headingPath)).toEqual([
      [],
      ["API"],
      ["API", "writeFile"],
      ["API", "writeFile", "Errors"],
      ["End"],
      ["Zed"],
    ]);
    expect(sections[2].content).toBe("## writeFile ##\nWrites.\n");
    expect(sections[2].searchableText).toContain("a.md\nAPI > writeFile");
  });

  test("does not treat heading-like lines inside backtick or tilde fences as headings", () => {
    const content = [
      "# Actual",
      "```md",
      "## Not a heading",
      "```ts this is code, not a closing fence",
      "### Still fenced",
      "```",
      "~~~",
      "## Also not a heading",
      "~~~",
      "## Real child",
      "Body.",
      "",
    ].join("\n");

    const sections = sectionArtifact(
      artifact([{ relativePath: "fences.md", content }]),
    );

    expect(sections).toHaveLength(2);
    expect(sections.map((section) => section.headingPath)).toEqual([
      ["Actual"],
      ["Actual", "Real child"],
    ]);
    expect(sections.map((section) => section.content).join("")).toBe(content);
  });

  test("prefers paragraph boundaries and hard-splits a single oversized paragraph without loss", () => {
    const content = "12345\n\n67890ABCDEFGHIJ";
    const sections = sectionArtifact(
      artifact([{ relativePath: "large.md", content }]),
      { maxSectionChars: 10 },
    );

    expect(sections.map((section) => section.content)).toEqual([
      "12345\n\n",
      "67890ABCDE",
      "FGHIJ",
    ]);
    expect(sections.every((section) => section.content.length <= 10)).toBe(
      true,
    );
    expect(sections.map((section) => section.content).join("")).toBe(content);
    expect(sections.map((section) => section.ordinal)).toEqual([0, 1, 2]);
  });

  test("preserves CRLF paragraph separators when splitting", () => {
    const content = "abc\r\n\r\ndefghijk";
    const sections = sectionArtifact(
      artifact([{ relativePath: "crlf.md", content }]),
      { maxSectionChars: 8 },
    );

    expect(sections[0].content).toBe("abc\r\n\r\n");
    expect(sections.map((section) => section.content).join("")).toBe(content);
  });

  test("keeps empty Markdown documents addressable and ignores non-Markdown documents", () => {
    const sections = sectionArtifact(
      artifact([
        { relativePath: "empty.MD", content: "" },
        { relativePath: "metadata.json", content: "{}" },
      ]),
    );

    expect(sections).toEqual([
      {
        id: "empty.MD::0000",
        relativePath: "empty.MD",
        headingPath: [],
        ordinal: 0,
        content: "",
        searchableText: "empty.MD",
      },
    ]);
  });

  test("uses the documented default cap", () => {
    const content = "x".repeat(DEFAULT_MAX_SECTION_CHARS + 1);
    const sections = sectionArtifact(
      artifact([{ relativePath: "default.md", content }]),
    );

    expect(sections.map((section) => section.content.length)).toEqual([
      DEFAULT_MAX_SECTION_CHARS,
      1,
    ]);
  });

  test.each([0, -1, 1.5, Number.NaN])(
    "rejects invalid maxSectionChars %s",
    (maxSectionChars) => {
      expect(() => sectionArtifact(artifact([]), { maxSectionChars })).toThrow(
        "maxSectionChars must be a positive integer",
      );
    },
  );
});
