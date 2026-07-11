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
