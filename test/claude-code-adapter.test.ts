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

describe("claudeCodeAdapter.parseEvent", () => {
  test("system init yields a session event and a debug event", () => {
    const events = claudeCodeAdapter.parseEvent({
      type: "system",
      subtype: "init",
      session_id: "sess-abc",
      model: "claude-sonnet-5",
    });

    expect(events).toEqual([
      { type: "session", sessionId: "sess-abc" },
      {
        type: "openwiki",
        event: {
          type: "debug",
          message: "claude-code session initialized model=claude-sonnet-5",
        },
      },
    ]);
  });

  test("assistant text blocks become text events", () => {
    const events = claudeCodeAdapter.parseEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Working on it." }],
      },
    });

    expect(events).toEqual([
      {
        type: "openwiki",
        event: { source: "main", type: "text", text: "Working on it." },
      },
    ]);
  });

  test("assistant tool_use blocks become tool_start events", () => {
    const events = claudeCodeAdapter.parseEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Reading." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Read",
            input: { file_path: "README.md" },
          },
        ],
      },
    });

    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({
      type: "openwiki",
      event: {
        type: "tool_start",
        call: 'Read(file_path="README.md")',
        id: "toolu_1",
        input: { file_path: "README.md" },
        name: "Read",
      },
    });
  });

  test("tool results become tool_end events with error status mapping", () => {
    const ok = claudeCodeAdapter.parseEvent({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", is_error: false },
        ],
      },
    });
    const failed = claudeCodeAdapter.parseEvent({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_2", is_error: true },
        ],
      },
    });

    expect(ok).toEqual([
      {
        type: "openwiki",
        event: {
          type: "tool_end",
          id: "toolu_1",
          name: "tool",
          status: "finished",
        },
      },
    ]);
    expect(failed[0]).toEqual({
      type: "openwiki",
      event: {
        type: "tool_end",
        id: "toolu_2",
        name: "tool",
        status: "error",
      },
    });
  });

  test("result events map success and error subtypes", () => {
    expect(
      claudeCodeAdapter.parseEvent({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
      }),
    ).toEqual([{ type: "result", ok: true, errorMessage: undefined }]);

    expect(
      claudeCodeAdapter.parseEvent({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "Invalid API key · Please run /login",
      }),
    ).toEqual([
      {
        type: "result",
        ok: false,
        errorMessage: "Invalid API key · Please run /login",
      },
    ]);
  });

  test("unknown lines are ignored", () => {
    expect(claudeCodeAdapter.parseEvent("not json-shaped")).toEqual([]);
    expect(claudeCodeAdapter.parseEvent({ type: "mystery" })).toEqual([]);
    expect(claudeCodeAdapter.parseEvent(null)).toEqual([]);
  });
});
