import { describe, expect, test } from "vitest";
import { createSystemPrompt } from "../src/agent/prompt.ts";

describe("createSystemPrompt engines", () => {
  test("deepagents variant keeps the virtual filesystem discipline", () => {
    const prompt = createSystemPrompt("init");

    expect(prompt).toContain("Use virtual paths such as /README.md");
    expect(prompt).toContain("read_file");
    expect(prompt).toContain("Use /openwiki/_plan.md when writing this temporary plan");
    expect(prompt).toContain(
      "When writing required documentation with filesystem tools, use /openwiki/... paths",
    );
  });

  test("agent-cli variant uses repository-relative paths and no DeepAgents tool names", () => {
    const prompt = createSystemPrompt("init", "agent-cli");

    expect(prompt).toContain("repository-relative paths");
    expect(prompt).toContain("rm -f openwiki/_plan.md");
    expect(prompt).not.toContain("read_file");
    expect(prompt).not.toContain("virtual paths");
    expect(prompt).not.toContain("/openwiki/_plan.md");
  });

  test("mode instructions are engine-independent", () => {
    expect(createSystemPrompt("update", "agent-cli")).toContain(
      "maintenance update run",
    );
    expect(createSystemPrompt("chat", "agent-cli")).toContain(
      "interactive chat turn",
    );
  });
});
