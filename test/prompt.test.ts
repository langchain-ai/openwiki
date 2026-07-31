import { describe, expect, test } from "vitest";
import { createSystemPrompt, createUserPrompt } from "../src/agent/prompt.ts";

describe("createSystemPrompt output language", () => {
  test("instructs the agent to write wiki documentation in the selected language", () => {
    const prompt = createSystemPrompt("init", "repository", "zh-CN");

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
    expect(createSystemPrompt("init", "repository")).not.toContain(
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

/**
 * The translation middleware is the sole owner of the
 * `openwiki_translation_pending` marker. The prompt must tell the agent to leave
 * it alone so the model never adds, edits, or clears a marker code manages.
 */
describe("createSystemPrompt translation-marker guidance", () => {
  for (const outputMode of ["repository", "local-wiki"] as const) {
    test(`${outputMode} mode: tells the agent to ignore the pending marker`, () => {
      const prompt = createSystemPrompt("update", outputMode);

      expect(prompt).toContain("openwiki_translation_pending");
      expect(prompt).toMatch(/Do not add, edit, remove, or act on it/);
    });
  }
});

describe("createSystemPrompt diagram guidance", () => {
  test("is always present for init and update runs", () => {
    for (const command of ["init", "update"] as const) {
      const prompt = createSystemPrompt(command);

      expect(prompt).toContain("Diagram discipline:");
      expect(prompt).toContain("```mermaid");
      for (const type of [
        "sequenceDiagram",
        "stateDiagram-v2",
        "erDiagram",
        "flowchart",
      ]) {
        expect(prompt).toContain(type);
      }
      expect(prompt).toContain("mermaid-diagrams skill");
      expect(prompt.toLowerCase()).not.toContain("semicolons");
      // Contract with the post-run degrade pass: the prompt must teach the exact
      // marker the validator embeds, or the repair loop never triggers.
      expect(prompt).toContain("openwiki: mermaid parse failed");
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

describe("createSystemPrompt repository init coverage", () => {
  test("maps the repository before writing and audits substantive coverage", () => {
    const prompt = createSystemPrompt("init", "repository");

    expect(prompt).toContain(
      "Concise means dense and non-redundant, not short",
    );
    expect(prompt).toContain("Build the map before writing prose");
    expect(prompt).toContain(
      "Inventory manifest-backed services, applications, packages, and workspaces",
    );
    expect(prompt).toContain(
      "Rank components and source areas by runtime importance, dependency centrality, change activity in recent history, public surface, and test ownership",
    );
    expect(prompt).toContain(
      "Group related files into coherent systems and cross-system workflows",
    );
    expect(prompt).toContain(
      "Create the complete wiki skeleton in /openwiki/_plan.md before drafting pages",
    );
    expect(prompt).toContain(
      "A passing mention, directory list, or source-map row is not substantive coverage",
    );
    expect(prompt).toContain("Optimize for path compression");
    expect(prompt).toContain("perform an unknown-unknown pass");
    expect(prompt).toContain(
      "reconcile the final wiki tree against the full inventory",
    );
    expect(prompt).toContain(
      "Never defer an area merely because of time, token, page-count, or navigation convenience.",
    );
    expect(prompt).toContain(
      "Substantial components and major workflows must be documented during init",
    );
  });
});

describe("createSystemPrompt mode isolation", () => {
  test("repository documentation runs omit local-wiki and chat-only guidance", () => {
    const prompt = createSystemPrompt("init", "repository");

    expect(prompt).toContain("Init workflow:");
    expect(prompt).toContain("Documentation contract:");
    expect(prompt).not.toContain("Connector ingestion discipline:");
    expect(prompt).not.toContain("Local knowledge synthesis discipline:");
    expect(prompt).not.toContain("Wiki-first question answering:");
    expect(prompt).not.toContain("OpenWiki CLI reference:");
  });

  test("local-wiki documentation runs retain connector synthesis without repository mapping", () => {
    const prompt = createSystemPrompt("init", "local-wiki");

    expect(prompt).toContain("Connector ingestion discipline:");
    expect(prompt).toContain("Local knowledge synthesis discipline:");
    expect(prompt).not.toContain("Repository mapping discipline:");
    expect(prompt).not.toContain("Repository decomposition and coverage:");
    expect(prompt).not.toContain("Coding-agent utility requirements:");
    expect(prompt).not.toContain("OpenWiki CLI reference:");
  });

  test("local-wiki updates use connector evidence without repository maintenance guidance", () => {
    const prompt = createSystemPrompt("update", "local-wiki");

    expect(prompt).toContain(
      "map changed evidence to the canonical topic, entity, source, theme, or open-question pages",
    );
    expect(prompt).toContain(
      "Synthesize durable knowledge into canonical pages",
    );
    expect(prompt).not.toContain(
      "build a docs impact plan from the changed source files",
    );
    expect(prompt).not.toContain("Do not update Source Map sections");
    expect(prompt).not.toContain("persistent commit hash lists");
  });

  test("chat receives answering and CLI guidance without generation workflows", () => {
    for (const outputMode of ["repository", "local-wiki"] as const) {
      const prompt = createSystemPrompt("chat", outputMode);

      expect(prompt).toContain("Wiki-first question answering:");
      expect(prompt).toContain("OpenWiki CLI reference:");
      expect(prompt).toContain("Front matter requirements (OKF):");
      expect(prompt).not.toContain("Repository mapping discipline:");
      expect(prompt).not.toContain("Planning discipline:");
      expect(prompt).not.toContain("Documentation goals:");
      expect(prompt).not.toContain("Diagram discipline:");
      expect(prompt).not.toContain("Local knowledge synthesis discipline:");
    }
  });
});

describe("createUserPrompt mode isolation", () => {
  const context = {
    lastUpdate: null,
  };

  test("does not inject precomputed source or git context", () => {
    for (const outputMode of ["repository", "local-wiki"] as const) {
      for (const command of ["init", "update"] as const) {
        const prompt = createUserPrompt(command, context, null, outputMode);
        expect(prompt).not.toContain("Source context:");
        expect(prompt).not.toContain("Git context:");
        expect(prompt).not.toContain("Git change summary:");
      }
    }
  });

  test("tells code runs to inspect git history themselves", () => {
    expect(createSystemPrompt("init", "repository")).toContain(
      "Read git history when it helps establish repository context",
    );

    const update = createSystemPrompt("update", "repository");
    expect(update).toContain(
      "note its `gitHead` as the last documented commit",
    );
    expect(update).toContain("git log <gitHead>..HEAD --name-status --oneline");
  });
});

describe("prompt template replacement", () => {
  test("resolves every template variable for all six prompt variants", () => {
    const context = {
      lastUpdate: null,
      wikiGoal: "Document the important behavior.",
    };

    for (const outputMode of ["repository", "local-wiki"] as const) {
      for (const command of ["chat", "init", "update"] as const) {
        const systemPrompt = createSystemPrompt(command, outputMode, "en");
        const userPrompt = createUserPrompt(
          command,
          context,
          "Inspect the relevant evidence.",
          outputMode,
          "/tmp/openwiki-root",
        );

        expect(systemPrompt).not.toMatch(/\{[A-Z_]+\}/u);
        expect(userPrompt).not.toMatch(/\{[A-Z_]+\}/u);
        expect(userPrompt).toContain("/tmp/openwiki-root");
      }
    }
  });
});
