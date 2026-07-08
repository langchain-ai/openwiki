import { describe, expect, test } from "vitest";
import { OPEN_WIKI_DIR } from "../src/constants.ts";
import { createSystemPrompt } from "../src/agent/prompt.ts";

describe("createSystemPrompt", () => {
  test("includes root agent instruction guidance by default", () => {
    const prompt = createSystemPrompt("init");

    expect(prompt).toContain("Root agent instruction files:");
    expect(prompt).toContain("If neither exists, create top-level /AGENTS.md");
    expect(prompt).toContain("Use this exact section structure every time");
    expect(prompt).toContain("OpenWiki reference section described above");
  });

  test("omits root instruction-file edits with --no-agent-instructions", () => {
    const prompt = createSystemPrompt("init", {
      noAgentInstructions: true,
    });

    expect(prompt).toContain(
      "Do not create, edit, append, or refresh top-level /AGENTS.md or /CLAUDE.md.",
    );
    expect(prompt).toContain(`Keep all documentation under ${OPEN_WIKI_DIR}/.`);
    expect(prompt).not.toContain(
      "If neither exists, create top-level /AGENTS.md",
    );
    expect(prompt).not.toContain("Use this exact section structure every time");
    expect(prompt).not.toContain("OpenWiki reference section described above");
  });
});
