import { describe, expect, test } from "vitest";
import {
  createCliSystemPrompt,
  createCliUserPrompt,
  getCliOutputPromptConfig,
} from "../src/agent/cli-runner/prompt.ts";
import type { RunContext } from "../src/agent/types.ts";

const CONTEXT: RunContext = {
  gitSummary: "GIT-SUMMARY",
  lastUpdate: null,
};

describe("getCliOutputPromptConfig", () => {
  test("repository mode uses real repo-relative paths", () => {
    const config = getCliOutputPromptConfig("repository");

    expect(config.quickstartPath).toBe("openwiki/quickstart.md");
    expect(config.metadataPath).toBe("openwiki/.last-update.json");
    expect(config.planPath).toBe("openwiki/_plan.md");
    expect(config.removePlanCommand).toBe("rm -f openwiki/_plan.md");
    expect(config.filesystemRootInstruction).not.toContain("virtual");
  });

  test("local-wiki mode uses cwd-relative paths", () => {
    const config = getCliOutputPromptConfig("local-wiki");

    expect(config.quickstartPath).toBe("quickstart.md");
    expect(config.metadataPath).toBe(".last-update.json");
    expect(config.removePlanCommand).toBe("rm -f _plan.md");
    expect(config.filesystemRootInstruction).not.toContain("virtual");
  });

  test("repository write boundary and root agent instructions use real paths", () => {
    const config = getCliOutputPromptConfig("repository");

    expect(config.writeBoundaryInstruction).not.toMatch(/[\s(]\/openwiki\b/);
    expect(config.writeBoundaryInstruction).toContain(
      "under the repository's openwiki/ directory",
    );
    expect(config.rootAgentInstructions).not.toMatch(
      /[\s(]\/(?:openwiki\b|AGENTS\.md|CLAUDE\.md)/,
    );
    expect(config.rootAgentInstructions).toContain("openwiki/INSTRUCTIONS.md");
    expect(config.rootAgentInstructions).toContain(
      "AGENTS.md or CLAUDE.md files at the repository root",
    );
  });

  test("local-wiki write boundary and synthesis block use cwd-relative paths", () => {
    const config = getCliOutputPromptConfig("local-wiki");

    expect(config.writeBoundaryInstruction).not.toContain("filesystem tools");
    expect(config.writeBoundaryInstruction).toContain(
      "current working directory",
    );
    expect(config.localWikiSynthesisInstruction).not.toMatch(
      /[\s(]\/(?:quickstart|open-questions|themes|commitments|personal-logistics)\.md/,
    );
    expect(config.localWikiSynthesisInstruction).not.toContain("/sources/");
    expect(config.localWikiSynthesisInstruction).toContain("- quickstart.md:");
    expect(config.localWikiSynthesisInstruction).toContain(
      "- sources/<connector>.md:",
    );
    expect(config.localWikiSynthesisInstruction).toContain(
      "read open-questions.md if it exists",
    );
  });
});

describe("createCliSystemPrompt", () => {
  test("contains no virtual-path or langchain tool instructions", () => {
    const prompt = createCliSystemPrompt("init", "repository", "claude-code");

    expect(prompt).not.toContain("virtual path");
    expect(prompt).not.toContain("virtual filesystem");
    expect(prompt).not.toContain("write_file");
    expect(prompt).not.toContain("openwiki_ingest");
    expect(prompt).toContain("openwiki/quickstart.md");
    expect(prompt).toContain("Do not modify source code.");
  });

  test("keeps mode instructions per command", () => {
    expect(
      createCliSystemPrompt("init", "repository", "claude-code"),
    ).toContain("initial documentation run");
    expect(
      createCliSystemPrompt("update", "repository", "claude-code"),
    ).toContain("maintenance update run");
    expect(
      createCliSystemPrompt("chat", "repository", "claude-code"),
    ).toContain("interactive chat turn");
  });

  test("includes subagent guidance only for claude", () => {
    expect(
      createCliSystemPrompt("init", "repository", "claude-code"),
    ).toContain("subagent");
    expect(
      createCliSystemPrompt("init", "repository", "codex-cli"),
    ).not.toContain("subagent");
  });

  test("repository system prompt never uses leading-slash wiki paths", () => {
    const prompt = createCliSystemPrompt("init", "repository", "claude-code");

    expect(prompt).not.toMatch(/[\s(]\/openwiki\b/);
    expect(prompt).not.toMatch(/[\s(]\/(?:AGENTS|CLAUDE)\.md/);
    expect(prompt).toContain("openwiki/INSTRUCTIONS.md");
    expect(prompt).toContain(
      "AGENTS.md or CLAUDE.md files at the repository root",
    );
    expect(prompt).toContain("only under the repository's openwiki/ directory");
  });

  test("local-wiki system prompt uses the real cwd write boundary", () => {
    const prompt = createCliSystemPrompt("update", "local-wiki", "claude-code");

    expect(prompt).not.toContain("virtual");
    expect(prompt).not.toContain("constrained connector tools");
    expect(prompt).not.toMatch(
      /[\s(]\/(?:quickstart|open-questions|themes|commitments|personal-logistics|sources|_plan)\b/,
    );
    expect(prompt).toContain(
      "Do not modify files outside the current working directory",
    );
    expect(prompt).toContain("rm -f _plan.md");
    expect(prompt).toContain("such as quickstart.md");
  });
});

describe("createCliUserPrompt", () => {
  test("wraps the standard user prompt with a real-path runtime note", () => {
    const prompt = createCliUserPrompt(
      "init",
      "/work/repo",
      CONTEXT,
      {},
      "repository",
    );

    expect(prompt).toContain("GIT-SUMMARY");
    expect(prompt).toContain("/work/repo");
    expect(prompt).toContain("current working directory");
    expect(prompt).not.toContain("virtual");
  });

  test("repository runtime note never uses leading-slash wiki paths", () => {
    const prompt = createCliUserPrompt(
      "init",
      "/work/repo",
      CONTEXT,
      {},
      "repository",
    );

    expect(prompt).not.toMatch(/[\s(]\/openwiki\b/);
    expect(prompt).toContain("only under the repository's openwiki/ directory");
  });

  test("local-wiki runtime note uses the real cwd write boundary", () => {
    const prompt = createCliUserPrompt(
      "update",
      "/home/user/.openwiki/wiki",
      CONTEXT,
      {},
      "local-wiki",
    );

    expect(prompt).toContain("Local wiki root");
    expect(prompt).toContain("/home/user/.openwiki/wiki");
    expect(prompt).toContain(
      "Do not modify files outside the current working directory",
    );
    expect(prompt).not.toContain("virtual");
    expect(prompt).not.toContain("constrained connector tools");
  });

  test("followup chat message passes through untouched", () => {
    const prompt = createCliUserPrompt(
      "chat",
      "/work/repo",
      CONTEXT,
      { isFollowup: true, userMessage: "  follow up  " },
      "repository",
    );

    expect(prompt).toBe("follow up");
  });
});
