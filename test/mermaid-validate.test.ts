import { afterEach, describe, expect, test } from "vitest";
import {
  degradeInvalidMermaidFences,
  findInvalidMermaidFences,
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
    expect(sanitizeMermaidError(new Error("x".repeat(500))).length).toBe(300);
    expect(sanitizeMermaidError(new Error(""))).toBe("unknown error");
  });
});
