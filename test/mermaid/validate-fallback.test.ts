import { describe, expect, test, vi } from "vitest";

// Force the optional `mermaid` peer dependency to look uninstalled: the dynamic
// import rejects, so `loadMermaid()` must swallow the failure, resolve to
// undefined, and callers must fall back to the conservative heuristic instead of
// crashing the wiki run. This is the "no authoritative parser" path that cannot
// be reached while mermaid is actually installed in the test env.
vi.mock("mermaid", () => {
  throw Object.assign(new Error("Cannot find package 'mermaid'"), {
    code: "ERR_MODULE_NOT_FOUND",
  });
});

import {
  findInvalidMermaidFences,
  loadMermaid,
} from "../../src/mermaid/validate.ts";

/** Wraps a diagram body in a ```mermaid fenced block. */
function fence(body: string): string {
  return ["```mermaid", body, "```"].join("\n");
}

describe("mermaid parser unavailable", () => {
  test("loadMermaid resolves to undefined rather than throwing", async () => {
    await expect(loadMermaid()).resolves.toBeUndefined();
  });

  test("falls back to the heuristic and still flags a near-certain breakage", async () => {
    // `end` as a flowchart node id is caught by the heuristic even with no real
    // parser, so an obviously broken diagram is not silently accepted.
    const errors = await findInvalidMermaidFences(
      fence("flowchart TD\n  A[Start] --> end[The End]"),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/reserved word/u);
  });

  test("passes a diagram the heuristic cannot fault", async () => {
    // The heuristic is deliberately conservative, so a clean flowchart is left
    // alone even though no authoritative parser ran.
    const errors = await findInvalidMermaidFences(
      fence("flowchart TD\n  A[Start] --> B[Done]"),
    );

    expect(errors).toHaveLength(0);
  });
});
