import { describe, expect, test } from "vitest";
import { claudeAdapter } from "../src/agent/cli-runner/claude.ts";
import type { CliRunSpec } from "../src/agent/cli-runner/types.ts";

const BASE_SPEC: CliRunSpec = {
  command: "init",
  cwd: "/repo",
  modelId: "sonnet",
  outputMode: "repository",
  resumeSessionId: null,
  systemPrompt: "SYSTEM",
  userPrompt: "USER",
};

const INIT_LINE = JSON.stringify({
  type: "system",
  subtype: "init",
  cwd: "/repo",
  session_id: "016b7e7b-d417-4219-a519-89e6407a961d",
});

const TOOL_USE_LINE = JSON.stringify({
  type: "assistant",
  message: {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "toolu_011yB1jJZ9RkM34U3DzWZv4f",
        name: "Bash",
        input: { command: "echo hello", description: "Run echo hello" },
      },
    ],
  },
});

const THINKING_LINE = JSON.stringify({
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "thinking", thinking: "internal", signature: "sig" }],
  },
});

const TEXT_LINE = JSON.stringify({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "OK" }] },
});

const TOOL_RESULT_LINE = JSON.stringify({
  type: "user",
  message: {
    role: "user",
    content: [
      {
        tool_use_id: "toolu_011yB1jJZ9RkM34U3DzWZv4f",
        type: "tool_result",
        content: "hello",
        is_error: false,
      },
    ],
  },
});

const RESULT_LINE = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "OK",
  session_id: "016b7e7b-d417-4219-a519-89e6407a961d",
  total_cost_usd: 0,
  num_turns: 2,
});

describe("claudeAdapter.buildArgs", () => {
  test("builds headless stream-json argv without user prompt", () => {
    const args = claudeAdapter.buildArgs(BASE_SPEC);

    expect(args).toContain("-p");
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("--append-system-prompt");
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(args).not.toContain("USER");
    expect(args).not.toContain("--resume");
  });

  test("allowedTools excludes network tools and broad bash", () => {
    const args = claudeAdapter.buildArgs(BASE_SPEC);
    const allowed = args[args.indexOf("--allowedTools") + 1];

    expect(allowed).toContain("Read");
    expect(allowed).toContain("Bash(git log:*)");
    expect(allowed).not.toContain("WebFetch");
    expect(allowed).not.toContain("WebSearch");
    expect(allowed).not.toContain("Bash(rm -rf");
  });

  test("adds --resume for followup runs", () => {
    const args = claudeAdapter.buildArgs({
      ...BASE_SPEC,
      resumeSessionId: "session-1",
    });

    expect(args[args.indexOf("--resume") + 1]).toBe("session-1");
  });
});

describe("claudeAdapter.stdinPayload", () => {
  test("stdin carries only the user prompt", () => {
    expect(claudeAdapter.stdinPayload(BASE_SPEC)).toBe("USER");
  });
});

describe("claudeAdapter.parseLine", () => {
  test("captures session id from system init", () => {
    expect(claudeAdapter.parseLine(INIT_LINE)).toEqual([
      { kind: "session", sessionId: "016b7e7b-d417-4219-a519-89e6407a961d" },
    ]);
  });

  test("maps tool_use to tool_start", () => {
    const [parsed] = claudeAdapter.parseLine(TOOL_USE_LINE);

    expect(parsed).toMatchObject({
      kind: "event",
      event: {
        type: "tool_start",
        id: "toolu_011yB1jJZ9RkM34U3DzWZv4f",
        name: "Bash",
      },
    });
  });

  test("skips thinking blocks", () => {
    expect(claudeAdapter.parseLine(THINKING_LINE)).toEqual([]);
  });

  test("maps text blocks to text events", () => {
    expect(claudeAdapter.parseLine(TEXT_LINE)).toEqual([
      { kind: "event", event: { type: "text", text: "OK" } },
    ]);
  });

  test("maps tool_result to tool_end", () => {
    const [parsed] = claudeAdapter.parseLine(TOOL_RESULT_LINE);

    expect(parsed).toMatchObject({
      kind: "event",
      event: {
        type: "tool_end",
        id: "toolu_011yB1jJZ9RkM34U3DzWZv4f",
        status: "finished",
      },
    });
  });

  test("maps result to run result", () => {
    const parsed = claudeAdapter.parseLine(RESULT_LINE);

    expect(parsed[0]).toEqual({
      kind: "result",
      isError: false,
      message: "OK",
    });
  });

  test("treats error results as failures", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "boom",
    });

    expect(claudeAdapter.parseLine(line)[0]).toEqual({
      kind: "result",
      isError: true,
      message: "boom",
    });
  });

  test("ignores unparseable and irrelevant lines without throwing", () => {
    expect(claudeAdapter.parseLine("")).toEqual([]);
    expect(claudeAdapter.parseLine("not json")).toEqual([
      {
        kind: "event",
        event: {
          type: "debug",
          message: expect.stringContaining("unparsed") as string,
        },
      },
    ]);
    expect(
      claudeAdapter.parseLine(JSON.stringify({ type: "rate_limit_event" })),
    ).toEqual([]);
  });
});
