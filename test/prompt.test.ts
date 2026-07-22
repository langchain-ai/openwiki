import { describe, expect, test } from "vitest";
import { createSystemPrompt, createUserPrompt } from "../src/agent/prompt.ts";
import type { RunContext } from "../src/agent/types.ts";

/**
 * Guards against the 0.2 regression where the shared "Canonical wiki location"
 * and "Wiki-first question answering" blocks hardcoded ~/.openwiki/wiki and
 * leaked into repository (code) mode. In code mode the filesystem virtual root
 * maps to the repo, so instructing the model to use ~/.openwiki/wiki made it
 * type non-absolute host paths into filesystem tools and crash the run.
 */
describe("createSystemPrompt filesystem path guidance", () => {
  const commands = ["init", "update", "chat"] as const;

  describe("repository mode", () => {
    for (const command of commands) {
      test(`${command}: does not point the wiki at ~/.openwiki/wiki`, () => {
        const prompt = createSystemPrompt(command, "repository");

        // The canonical location must be the repo-local /openwiki, never the
        // personal-brain home dir.
        expect(prompt).not.toMatch(/lives in ~\/\.openwiki\/wiki/);
        expect(prompt).not.toMatch(/inspect ~\/\.openwiki\/wiki first/);
        expect(prompt).toContain("/openwiki");
      });
    }
  });

  describe("local-wiki mode", () => {
    for (const command of commands) {
      test(`${command}: roots the wiki at ~/.openwiki/wiki via virtual /`, () => {
        const prompt = createSystemPrompt(command, "local-wiki");

        expect(prompt).toContain("~/.openwiki/wiki");
        expect(prompt).toContain("/quickstart.md");
      });
    }
  });

  test("both modes forbid typing host/tilde paths into filesystem tools", () => {
    for (const outputMode of ["repository", "local-wiki"] as const) {
      const prompt = createSystemPrompt("update", outputMode);
      expect(prompt).toMatch(
        /Never type ~, ~\/\.openwiki\/wiki, or host paths/,
      );
    }
  });
});

/**
 * The deterministic post-run pass repairs missing or invalid front matter and
 * tags the page `openwiki_generated`. The prompt must tell the agent that code
 * owns conformance and that it should enrich those flagged pages, so quality
 * fills in over later runs instead of code guessing forever.
 */
describe("createSystemPrompt openwiki_generated enrichment guidance", () => {
  for (const outputMode of ["repository", "local-wiki"] as const) {
    test(`${outputMode} mode: instructs the agent to enrich and clear the mark`, () => {
      const prompt = createSystemPrompt("update", outputMode);

      expect(prompt).toContain("openwiki_generated: true");
      expect(prompt).toMatch(/repairs front matter deterministically/);
      expect(prompt).toMatch(/remove the `openwiki_generated` field/);
    });
  }
});

describe("createSystemPrompt recursion roles", () => {
  test("subproject role scopes to one subproject and forbids siblings", () => {
    const prompt = createSystemPrompt("init", "repository", "subproject");
    expect(prompt).toContain("Monorepo subproject scope");
    expect(prompt).toMatch(/scoped to ONE subproject/);
    expect(prompt).toMatch(/document, read into, or write to sibling/i);
  });

  test("root role links down and does not deep-document subtrees", () => {
    const prompt = createSystemPrompt("init", "repository", "root");
    expect(prompt).toContain("Monorepo root scope");
    expect(prompt).toMatch(/link DOWN/);
    expect(prompt).toContain("openwiki/workspaces.md");
    expect(prompt).toMatch(/Do NOT deep-document/);
  });

  test("absent role adds no recursion section (backward compatible)", () => {
    const prompt = createSystemPrompt("init", "repository");
    expect(prompt).not.toContain("Monorepo subproject scope");
    expect(prompt).not.toContain("Monorepo root scope");
  });
});

describe("createUserPrompt recursion reminders", () => {
  const context: RunContext = {
    lastUpdate: null,
    gitSummary: "(git)",
    wikiGoal: undefined,
  };

  test("subproject reminder appears in the init user prompt", () => {
    const prompt = createUserPrompt(
      "init",
      context,
      null,
      "repository",
      "subproject",
    );
    expect(prompt).toMatch(/documenting a single subproject/);
  });

  test("root reminder appears in the update user prompt", () => {
    const prompt = createUserPrompt(
      "update",
      context,
      null,
      "repository",
      "root",
    );
    expect(prompt).toMatch(/this is the monorepo root/i);
    expect(prompt).toContain("openwiki/workspaces.md");
  });

  test("absent role leaves the user prompt unchanged", () => {
    const prompt = createUserPrompt("init", context, null, "repository");
    expect(prompt).not.toMatch(/Recursive monorepo run/);
  });
});
