import { describe, expect, test } from "vitest";
import { extractMermaidFences } from "../src/mermaid/fences.ts";

const VALID_SEQUENCE = `sequenceDiagram
  Alice->>Bob: Hello
  Bob-->>Alice: Hi`;

const VALID_ER = `erDiagram
  USER ||--o{ ORDER : places`;

/** Wraps a diagram body in a fenced block with the given info string and indent. */
function fence(body: string, info = "mermaid", indent = ""): string {
  const lines = body.split("\n").map((line) => `${indent}${line}`);

  return [`${indent}\`\`\`${info}`, ...lines, `${indent}\`\`\``].join("\n");
}

describe("extractMermaidFences", () => {
  test("finds mermaid fences and ignores other language fences", () => {
    const markdown = [
      "# Page",
      fence("console.log(1)", "ts"),
      fence(VALID_SEQUENCE),
      "Some prose.",
      fence(VALID_ER),
    ].join("\n\n");

    const fences = extractMermaidFences(markdown);

    expect(fences).toHaveLength(2);
    expect(fences[0].body).toBe(VALID_SEQUENCE);
    expect(fences[1].body).toBe(VALID_ER);
  });

  test("preserves the opening fence indentation", () => {
    const markdown = [
      "- item:",
      fence("flowchart TD\n  A --> B", "mermaid", "  "),
    ].join("\n");

    const fences = extractMermaidFences(markdown);

    expect(fences).toHaveLength(1);
    expect(fences[0].indent).toBe("  ");
    expect(fences[0].body).toContain("flowchart TD");
  });

  test("ignores a mermaid block nested inside a longer markdown fence", () => {
    const markdown = [
      "````markdown",
      "```mermaid",
      "not a real diagram",
      "```",
      "````",
    ].join("\n");

    expect(extractMermaidFences(markdown)).toHaveLength(0);
  });

  test("returns nothing for a document with no fences", () => {
    expect(extractMermaidFences("# Page\n\nJust prose.")).toHaveLength(0);
  });
});
