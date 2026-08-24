import { describe, expect, test } from "vitest";
import {
  createDiagramInstructions,
  createLinkIntegrityInstructions,
  createSystemPrompt,
  createUserPrompt,
} from "../../src/agent/prompt.ts";
import type { RunContext } from "../../src/agent/types.ts";

/**
 * A RunContext with every optional field absent, so a test can opt fields in one
 * at a time and confirm each fallback (the "(not provided)" wiki goal, the "no
 * metadata" line) independently.
 */
function emptyContext(overrides: Partial<RunContext> = {}): RunContext {
  return {
    lastUpdate: null,
    ...overrides,
  };
}

describe("createSystemPrompt output language", () => {
  test("instructs the agent to write wiki documentation in the selected language", () => {
    const prompt = createSystemPrompt("init", "local-wiki", "zh-CN");

    expect(prompt).toContain("Output language:");
    expect(prompt).toContain(
      "Write generated wiki prose, headings, table content, and documentation in zh-CN.",
    );
    expect(prompt).toContain(
      'write the human-readable "title", "description", and "type" values in zh-CN',
    );
    // The field rule must dominate the "keep technical terms unchanged" rule, or
    // a technical-term-dense description gets left in the source language.
    expect(prompt).toContain(
      "dense with product names, feature names, or technical terminology",
    );
    // Tags stay canonical (an aggregation key), so they are written in English.
    expect(prompt).toContain('Write the "tags" values in English');
    // Whole-wiki language reconciliation is code-owned: the agent must not
    // re-translate existing pages on a switch, so it never fights the separate
    // deterministic translation pass or acts on stale language metadata.
    expect(prompt).toContain(
      "brought existing pages into zh-CN in a separate deterministic pass",
    );
    expect(prompt).toContain("that whole-wiki reconciliation is code-owned");
    expect(prompt).toContain(
      "Apply this language only to generated wiki files.",
    );
    expect(prompt).toContain(
      "Keep code identifiers, file paths, commands, API names, URLs, and code blocks unchanged",
    );
  });

  test("preserves the existing prompt behavior when no language is supplied", () => {
    expect(createSystemPrompt("init", "local-wiki")).not.toContain(
      "Output language:",
    );
  });
});

/**
 * Guards against the 0.2 regression where the shared "Canonical wiki location"
 * and "Wiki-first question answering" blocks hardcoded ~/.openwiki/wiki and
 * leaked into repository (code) mode. In code mode the filesystem virtual root
 * maps to the repo, so instructing the model to use ~/.openwiki/wiki made it
 * type non-absolute host paths into filesystem tools and crash the run.
 */
describe("createSystemPrompt filesystem path guidance", () => {
  const commands = ["chat"] as const;

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

      test(`${command}: does not treat repository agent files as personal instructions`, () => {
        const prompt = createSystemPrompt(command, "local-wiki");

        expect(prompt).toContain(
          "Repository /AGENTS.md and /CLAUDE.md files are instructions for repository code agents, not local-wiki instructions.",
        );
        expect(prompt).toContain(
          "do not read or follow those files unless the user explicitly asks about their contents",
        );
      });
    }

    test("preserves unresolved source conflicts as contested knowledge", () => {
      const prompt = createSystemPrompt("update", "local-wiki");

      expect(prompt).toContain("contested:");
      expect(prompt).toContain("## Contested section");
      expect(prompt).toContain(
        "Never resolve a contested fact by recency alone",
      );
      expect(prompt).toContain(
        "Never present either side as confirmed or source-backed while the conflict remains unsettled",
      );
      expect(prompt).toContain(
        "Add an /open-questions.md entry only when the unresolved conflict would impair future assistance",
      );
    });
  });

  test("both modes forbid typing host paths into filesystem tools", () => {
    // The hazard differs by mode, so the guidance does too: repository update
    // warns against host *absolute* paths (/Users/...), since a repo has no
    // ~/.openwiki/wiki to confuse; local-wiki update additionally forbids ~ and
    // the wiki home. Both keep host paths out of the filesystem tools.
    expect(createSystemPrompt("chat", "repository")).toMatch(
      /Never pass host absolute paths like \/Users\/\.\.\. to filesystem tools/,
    );
    expect(createSystemPrompt("update", "local-wiki")).toMatch(
      /Never type ~, ~\/\.openwiki\/wiki, or host paths/,
    );
  });
});

/**
 * The deterministic post-run pass repairs missing or invalid front matter and
 * tags the page `openwiki_generated`. The prompt must tell the agent that code
 * owns conformance and that it should enrich those flagged pages, so quality
 * fills in over later runs instead of code guessing forever.
 */
describe("createSystemPrompt openwiki_generated enrichment guidance", () => {
  for (const outputMode of ["local-wiki"] as const) {
    test(`${outputMode} mode: instructs the agent to enrich and clear the mark`, () => {
      const prompt = createSystemPrompt("update", outputMode);

      expect(prompt).toContain("openwiki_generated: true");
      expect(prompt).toMatch(/repairs front matter deterministically/);
      expect(prompt).toMatch(/remove the `openwiki_generated` field/);
    });
  }
});

/**
 * The translation middleware is the sole owner of the
 * `openwiki_translation_pending` marker. The prompt must tell the agent to leave
 * it alone so the model never adds, edits, or clears a marker code manages.
 */
describe("createSystemPrompt translation-marker guidance", () => {
  for (const outputMode of ["local-wiki"] as const) {
    test(`${outputMode} mode: tells the agent to ignore the pending marker`, () => {
      const prompt = createSystemPrompt("update", outputMode);

      expect(prompt).toContain("openwiki_translation_pending");
      expect(prompt).toMatch(/Do not add, edit, remove, or act on it/);
    });
  }
});

describe("createDiagramInstructions", () => {
  test("nudges toward diagrams and defers label-safety to the skill", () => {
    const text = createDiagramInstructions();

    expect(text).toContain("Diagram discipline:");
    expect(text).toContain("```mermaid");
    // Names each of the four diagram types the skill documents.
    for (const type of [
      "sequenceDiagram",
      "stateDiagram-v2",
      "erDiagram",
      "flowchart",
    ]) {
      expect(text).toContain(type);
    }
    // Detailed syntax rules moved to the skill; the prompt points at it instead
    // of restating them.
    expect(text).toContain("mermaid-diagrams skill");
    expect(text.toLowerCase()).not.toContain("semicolons");
  });
});

describe("createLinkIntegrityInstructions", () => {
  test("teaches the post-run broken-link stamp marker for self-repair", () => {
    const text = createLinkIntegrityInstructions();

    expect(text).toContain("Link integrity:");
    expect(text).toContain("openwiki: broken internal link");
    expect(text).toContain("delete the comment");
  });
});

describe("createUserPrompt", () => {
  test("chat returns the user message verbatim, trimmed", () => {
    expect(createUserPrompt("chat", emptyContext(), "  what changed?  ")).toBe(
      "what changed?",
    );
  });

  test("chat falls back to a default opener when no message is given", () => {
    // A null or blank chat message must still yield a usable turn rather than an
    // empty prompt.
    expect(createUserPrompt("chat", emptyContext(), null)).toBe(
      "Start an OpenWiki chat.",
    );
    expect(createUserPrompt("chat", emptyContext(), "   ")).toBe(
      "Start an OpenWiki chat.",
    );
  });

  test("rejects repository init before building a user prompt", () => {
    expect(() =>
      createUserPrompt(
        "init",
        emptyContext({ wikiGoal: "Explain the CLI" }),
        null,
        "repository",
      ),
    ).toThrow("Repository generation does not use shared agent prompts.");
  });

  test("rejects repository init before building a system prompt", () => {
    expect(() => createSystemPrompt("init", "repository")).toThrow(
      "Repository generation does not use shared agent prompts.",
    );
  });

  test("init uses the personal-brain subject label in local-wiki mode", () => {
    const prompt = createUserPrompt("init", emptyContext(), null, "local-wiki");

    expect(prompt).toContain("the local knowledge wiki");
    // With no wiki goal supplied the brief falls back to the placeholder.
    expect(prompt).toContain("(not provided)");
  });

  test("update renders the previous-run metadata as pretty JSON", () => {
    // Only local-wiki mode inlines the recorded metadata into the prompt;
    // repository update instead tells the agent to read /openwiki/.last-update.json
    // from disk, so the {LAST_UPDATE} block lives on the personal template.
    const prompt = createUserPrompt(
      "update",
      emptyContext({
        lastUpdate: {
          updatedAt: "2026-07-28T00:00:00Z",
          command: "update",
          model: "gpt-5",
        },
      }),
      null,
      "local-wiki",
    );

    expect(prompt).toContain("Update the existing OpenWiki documentation");
    // formatLastUpdate serializes the metadata object so the agent can diff
    // against the recorded run state.
    expect(prompt).toContain('"model": "gpt-5"');
    expect(prompt).toContain('"command": "update"');
  });

  test("update states when no previous metadata exists", () => {
    const prompt = createUserPrompt("update", emptyContext(), null);

    expect(prompt).toContain("No previous OpenWiki update metadata was found.");
  });

  test("appends a trimmed user instruction block for local-wiki generation", () => {
    const prompt = createUserPrompt(
      "init",
      emptyContext(),
      "  focus on auth  ",
      "local-wiki",
    );

    expect(prompt).toContain("Additional user instruction:");
    expect(prompt).toContain("focus on auth");
    // The block is trimmed, so no leading/trailing whitespace leaks through.
    expect(prompt).not.toContain("  focus on auth  ");
  });

  test("rejects repository update before building a user prompt", () => {
    expect(() =>
      createUserPrompt("update", emptyContext(), null, "repository", "/repo"),
    ).toThrow("Repository generation does not use shared agent prompts.");
  });
});

describe("createSystemPrompt repository generation guards", () => {
  test("rejects repository init and update", () => {
    for (const command of ["init", "update"] as const) {
      expect(() => createSystemPrompt(command, "repository")).toThrow(
        "Repository generation does not use shared agent prompts.",
      );
    }
  });
});

describe("createSystemPrompt diagram guidance", () => {
  test("is always present for init and update runs", () => {
    for (const command of ["init", "update"] as const) {
      const prompt = createSystemPrompt(command);

      expect(prompt).toContain("Diagram discipline:");
      expect(prompt).toContain("```mermaid");
      // Contract with the post-run degrade pass: the prompt must teach the exact
      // marker the validator embeds, or the repair loop never triggers.
      expect(prompt).toContain("openwiki: mermaid parse failed");
      expect(prompt).toContain("Link integrity:");
      expect(prompt).toContain("openwiki: broken internal link");
      expect(prompt).toContain("Mode-specific behavior:");
    }
  });

  test("update mode permits opportunistically adding a missing diagram", () => {
    // Surgical-update discipline would otherwise suppress net-new diagrams on an
    // existing wiki; this carve-out lets diagrams reach already-built wikis.
    const update = createSystemPrompt("update");
    expect(update).toContain("adding one is a valuable improvement");

    // The carve-out is scoped to update runs, not repeated in init guidance.
    const init = createSystemPrompt("init");
    expect(init).not.toContain("adding one is a valuable improvement");
  });
});
