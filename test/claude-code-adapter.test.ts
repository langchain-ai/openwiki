import { describe, expect, test } from "vitest";
import {
  CLAUDE_CODE_ALLOWED_TOOLS,
  claudeCodeAdapter,
} from "../src/agent/engines/claude-code.ts";
import type { EngineRunSpec } from "../src/agent/engines/types.ts";

const baseSpec: EngineRunSpec = {
  command: "init",
  cwd: "/tmp/repo",
  modelId: "default",
  prompt: "Initialize docs.",
  systemPrompt: "You are OpenWiki.",
};

describe("claudeCodeAdapter.buildArgs", () => {
  test("builds headless stream-json args with the appended system prompt", () => {
    expect(claudeCodeAdapter.buildArgs(baseSpec)).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--append-system-prompt",
      "You are OpenWiki.",
      "--allowedTools",
      CLAUDE_CODE_ALLOWED_TOOLS,
    ]);
  });

  test("omits --model for the subscription default and adds it otherwise", () => {
    expect(claudeCodeAdapter.buildArgs(baseSpec)).not.toContain("--model");

    const args = claudeCodeAdapter.buildArgs({ ...baseSpec, modelId: "opus" });

    expect(args[args.indexOf("--model") + 1]).toBe("opus");
  });

  test("adds --resume for follow-up sessions", () => {
    const args = claudeCodeAdapter.buildArgs({
      ...baseSpec,
      resumeSessionId: "sess-1",
    });

    expect(args[args.indexOf("--resume") + 1]).toBe("sess-1");
  });

  test("allowed tools stay documentation-shaped", () => {
    const tools = CLAUDE_CODE_ALLOWED_TOOLS.split(",");

    expect(tools).toContain("Write");
    expect(tools).toContain("Edit");
    expect(tools).toContain("Bash(git log:*)");
    expect(tools).toContain("Bash(rm -f openwiki/_plan.md)");
    expect(tools).not.toContain("WebSearch");
    expect(tools).not.toContain("WebFetch");
  });
});

describe("claudeCodeAdapter.detectInstall", () => {
  test("reports a missing binary", async () => {
    const status = await claudeCodeAdapter.detectInstall(
      "definitely-not-a-real-binary-xyz",
    );

    expect(status.found).toBe(false);
  });

  test("reports a version for an executable that prints one", async () => {
    const status = await claudeCodeAdapter.detectInstall(process.execPath);

    expect(status.found).toBe(true);
    expect(status.version).toMatch(/\d+\.\d+/);
  });
});
