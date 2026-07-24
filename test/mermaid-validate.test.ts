import { afterEach, describe, expect, test } from "vitest";
import {
  degradeInvalidMermaidFences,
  findInvalidMermaidFences,
  heuristicError,
  sanitizeMermaidError,
} from "../src/mermaid/validate.ts";

const VALID_SEQUENCE = `sequenceDiagram
  Alice->>Bob: Hello
  Bob-->>Alice: Hi`;

const VALID_ER = `erDiagram
  USER ||--o{ ORDER : places`;

const VALID_STATE = `stateDiagram-v2
  [*] --> Idle
  Idle --> Running: start`;

const VALID_FLOWCHART = `flowchart TD
  A[Start] --> B{Check}
  B -->|yes| C[Done]`;

// A semicolon inside a message label is a statement separator, so this fails.
const BROKEN_LABEL = `sequenceDiagram
  Alice->>Bob: fetch(a; b)`;

// `end` is a reserved word and cannot be a bare flowchart node id.
const BROKEN_RESERVED_END = `flowchart TD
  A[Start] --> end[The End]`;

/** Wraps a diagram body in a ```mermaid fenced block. */
function mermaidFence(body: string): string {
  return ["```mermaid", body, "```"].join("\n");
}

describe("findInvalidMermaidFences", () => {
  test("accepts all four generated diagram types", async () => {
    const markdown = [VALID_SEQUENCE, VALID_ER, VALID_STATE, VALID_FLOWCHART]
      .map(mermaidFence)
      .join("\n\n");

    // Flowchart and state diagrams exercise the DOMPurify path, so a pass here
    // proves the jsdom shim is installed before mermaid loads.
    expect(await findInvalidMermaidFences(markdown)).toHaveLength(0);
  });

  test("flags a broken label and a reserved-word node id", async () => {
    const markdown = [BROKEN_LABEL, BROKEN_RESERVED_END]
      .map(mermaidFence)
      .join("\n\n");

    const errors = await findInvalidMermaidFences(markdown);

    expect(errors).toHaveLength(2);
    for (const { error } of errors) {
      expect(error.length).toBeGreaterThan(0);
    }
  });

  test("returns nothing when a document has no mermaid fences", async () => {
    expect(await findInvalidMermaidFences("# Page\n\nProse.")).toHaveLength(0);
  });
});

describe("degradeInvalidMermaidFences", () => {
  test("returns content unchanged when every fence parses", async () => {
    const markdown = `# Page\n\n${mermaidFence(VALID_SEQUENCE)}\n`;

    const result = await degradeInvalidMermaidFences(markdown);

    expect(result.degraded).toBe(0);
    expect(result.content).toBe(markdown);
  });

  test("degrades only failing fences and keeps the valid ones", async () => {
    const markdown = [
      "# Page",
      mermaidFence(VALID_SEQUENCE),
      mermaidFence(BROKEN_LABEL),
    ].join("\n\n");

    const result = await degradeInvalidMermaidFences(markdown);

    expect(result.degraded).toBe(1);
    // The valid diagram is left as a mermaid fence.
    expect(result.content).toContain(mermaidFence(VALID_SEQUENCE));
    // The broken one is degraded, with the repair marker and a text fence.
    expect(result.content).toContain("<!-- openwiki: mermaid parse failed");
    expect(result.content).toContain("```text");
    expect(result.content).toContain("fetch(a; b)");
  });

  test("produces output that itself passes validation", async () => {
    const markdown = mermaidFence(BROKEN_RESERVED_END);

    const result = await degradeInvalidMermaidFences(markdown);

    expect(result.degraded).toBe(1);
    expect(await findInvalidMermaidFences(result.content)).toHaveLength(0);
  });
});

describe("sanitizeMermaidError", () => {
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    if (originalAnthropicKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    }
  });

  test("collapses `--` so the embedded HTML comment stays well-formed", () => {
    const result = sanitizeMermaidError(new Error("bad -- token -- here"));

    expect(result).not.toContain("--");
    expect(result).toContain("bad - token - here");
  });

  test("redacts an environment secret that appears in the error", () => {
    process.env.ANTHROPIC_API_KEY = "supersecretkeyvalue123";

    const result = sanitizeMermaidError(
      new Error("request failed with key supersecretkeyvalue123"),
    );

    expect(result).not.toContain("supersecretkeyvalue123");
    expect(result).toContain("[REDACTED:");
  });

  test("caps length and falls back for empty errors", () => {
    expect(sanitizeMermaidError(new Error("x".repeat(500))).length).toBe(400);
    expect(sanitizeMermaidError(new Error(""))).toBe("unknown error");
  });

  test("keeps the parser diagnosis and drops caret-underline noise", () => {
    const err = new Error(
      "Parse error on line 20:\n... Svc->>Note: notify\n----------^\nExpecting 'ACTOR', got 'note'",
    );
    const result = sanitizeMermaidError(err);

    // The `Expecting ... got ...` line is what lets a later run repair the diagram.
    expect(result).toContain("Expecting 'ACTOR', got 'note'");
    expect(result).toContain("Parse error on line 20:");
    // The caret-underline line is dropped.
    expect(result).not.toContain("^");
  });
});

describe("heuristicError (fallback when mermaid is not installed)", () => {
  test("flags a reserved `end` node id in a flowchart", () => {
    expect(heuristicError("flowchart TD\n  A[Start] --> end[The End]")).toMatch(
      /reserved word/u,
    );
    expect(heuristicError("flowchart TD\n  A --> end")).toMatch(
      /reserved word/u,
    );
  });

  test("does not flag `end` when it closes a sequenceDiagram block", () => {
    const seq = "sequenceDiagram\n  loop retry\n    Alice->>Bob: ping\n  end";
    expect(heuristicError(seq)).toBeUndefined();
  });

  test("flags a semicolon inside a label", () => {
    expect(
      heuristicError("sequenceDiagram\n  Alice->>Bob: fetch(a; b)"),
    ).toMatch(/semicolon/u);
    expect(heuristicError('flowchart TD\n  A["step one; step two"]')).toMatch(
      /semicolon/u,
    );
  });

  test("flags an unescaped angle bracket inside a label", () => {
    expect(
      heuristicError("flowchart TD\n  A[returns Promise<User>] --> B"),
    ).toMatch(/angle bracket/u);
  });

  test("passes all four valid diagram types", () => {
    for (const body of [
      VALID_SEQUENCE,
      VALID_ER,
      VALID_STATE,
      VALID_FLOWCHART,
    ]) {
      expect(heuristicError(body)).toBeUndefined();
    }
  });

  test("does not false-flag the word `end` inside a label", () => {
    expect(
      heuristicError('flowchart TD\n  A["reach the end"] --> B'),
    ).toBeUndefined();
  });
});
