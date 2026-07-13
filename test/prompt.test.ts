import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createSystemPrompt, createUserPrompt } from "../src/agent/prompt.ts";
import type { RunContext } from "../src/agent/types.ts";

const SUBAGENT_ENV_KEY = "OPENWIKI_DISABLE_SUBAGENTS";
let previousSubagentValue: string | undefined;

beforeEach(() => {
  previousSubagentValue = process.env[SUBAGENT_ENV_KEY];
  delete process.env[SUBAGENT_ENV_KEY];
});

afterEach(() => {
  if (previousSubagentValue === undefined) {
    delete process.env[SUBAGENT_ENV_KEY];
  } else {
    process.env[SUBAGENT_ENV_KEY] = previousSubagentValue;
  }
});

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

describe("run discipline", () => {
  test("excludes openwiki.* variant directories from discovery", () => {
    expect(createSystemPrompt("init", "repository")).toContain(
      "Do not read, write, or search any openwiki.* variant directories",
    );
  });
});

describe("subagent discipline", () => {
  test("permits subagent delegation by default", () => {
    const prompt = createSystemPrompt("init", "repository");
    expect(prompt).toContain(
      "You may use the task tool to parallelize read-only research",
    );
  });

  test("OPENWIKI_DISABLE_SUBAGENTS=1 tells the agent not to delegate", () => {
    process.env[SUBAGENT_ENV_KEY] = "1";
    const prompt = createSystemPrompt("init", "repository");
    expect(prompt).toContain(
      "Do not use the task tool or delegate research to subagents",
    );
    expect(prompt).not.toContain(
      "You may use the task tool to parallelize read-only research",
    );
  });
});
