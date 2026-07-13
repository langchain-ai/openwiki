import { describe, expect, test } from "vitest";
import { createSystemPrompt, createUserPrompt } from "../src/agent/prompt.ts";
import type { RunContext } from "../src/agent/types.ts";

describe("createUserPrompt", () => {
  test("includes the wiki brief for repository init runs", () => {
    const context: RunContext = {
      gitSummary: "No git changes.",
      lastUpdate: null,
      wikiGoal: "Prioritize architecture and runbooks.",
    };

    expect(createUserPrompt("init", context, null, "repository")).toContain(
      "Prioritize architecture and runbooks.",
    );
  });

  test("treats repository INSTRUCTIONS.md as read-only brief metadata", () => {
    const prompt = createSystemPrompt("init", "repository");

    expect(prompt).toContain("/openwiki/INSTRUCTIONS.md");
    expect(prompt).toContain("shared, user-authored OpenWiki brief");
    expect(prompt).toContain("do not edit it during normal init/update/chat");
  });
});

describe("documentation coverage guidance", () => {
  test("init records deferred domains in the quickstart backlog", () => {
    const prompt = createSystemPrompt("init", "repository");

    expect(prompt).toContain("## Backlog");
    expect(prompt).toContain("area name, source anchor, and a one-line reason");
    expect(prompt).toContain(
      "Do not silently drop a real domain or workflow because of the page budget",
    );
  });

  test("update promotes relevant backlog entries instead of dropping them", () => {
    const prompt = createSystemPrompt("update", "repository");

    expect(prompt).toContain("Read the existing `## Backlog` section");
    expect(prompt).toContain(
      "Promote a backlog entry when recent changes touch that area",
    );
    expect(prompt).toContain("remove the entry from the backlog");
  });

  test("all documentation runs perform a coverage self-check", () => {
    for (const command of ["chat", "init", "update"] as const) {
      expect(createSystemPrompt(command, "repository")).toContain(
        "Before finishing, verify that every identified area is either documented or backlogged",
      );
    }
  });
});
