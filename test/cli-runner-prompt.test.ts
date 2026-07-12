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
