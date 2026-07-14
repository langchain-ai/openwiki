import { describe, expect, test } from "vitest";
import { codexAdapter } from "../src/agent/cli-runner/codex.ts";
import type { CliRunSpec } from "../src/agent/cli-runner/types.ts";

const BASE_SPEC: CliRunSpec = {
  command: "init",
  cwd: "/repo",
  modelId: "gpt-5.6-terra",
  outputMode: "repository",
  resumeSessionId: null,
  systemPrompt: "SYSTEM",
  userPrompt: "USER",
};

const THREAD_LINE = JSON.stringify({
  type: "thread.started",
  thread_id: "019f54e5-6409-7bf3-8788-4732226cb68a",
});

const MESSAGE_LINE = JSON.stringify({
  type: "item.completed",
  item: { id: "item_2", type: "agent_message", text: "OK" },
});

const COMMAND_START_LINE = JSON.stringify({
  type: "item.started",
  item: {
    id: "item_1",
    type: "command_execution",
    command: "/bin/bash -lc 'echo hello'",
    aggregated_output: "",
    exit_code: null,
    status: "in_progress",
  },
});

const COMMAND_DONE_LINE = JSON.stringify({
  type: "item.completed",
  item: {
    id: "item_1",
    type: "command_execution",
    command: "/bin/bash -lc 'echo hello'",
    aggregated_output: "hello\n",
    exit_code: 0,
    status: "completed",
  },
});

const USAGE_LINE = JSON.stringify({
  type: "turn.completed",
  usage: {
    input_tokens: 24521,
    cached_input_tokens: 22016,
    output_tokens: 113,
  },
});

describe("codexAdapter.buildArgs", () => {
  test("builds exec argv with stdin prompt sentinel", () => {
    const args = codexAdapter.buildArgs(BASE_SPEC);

    expect(args[0]).toBe("exec");
    expect(args).toContain("--json");
    expect(args).toContain("--skip-git-repo-check");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("workspace-write");
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.6-terra");
    expect(args.at(-1)).toBe("-");
    expect(args).not.toContain("USER");
  });

  test("uses exec resume for followups", () => {
    const args = codexAdapter.buildArgs({
      ...BASE_SPEC,
      resumeSessionId: "thread-9",
    });

    expect(args.slice(0, 3)).toEqual(["exec", "resume", "thread-9"]);
    expect(args.at(-1)).toBe("-");
  });
});

describe("codexAdapter.stdinPayload", () => {
  test("stdin carries system and user prompt combined", () => {
    expect(codexAdapter.stdinPayload(BASE_SPEC)).toBe("SYSTEM\n\nUSER");
  });
});

describe("codexAdapter.parseLine", () => {
  test("captures thread id as session", () => {
    expect(codexAdapter.parseLine(THREAD_LINE)).toEqual([
      { kind: "session", sessionId: "019f54e5-6409-7bf3-8788-4732226cb68a" },
    ]);
  });

  test("maps agent_message completion to text", () => {
    expect(codexAdapter.parseLine(MESSAGE_LINE)).toEqual([
      { kind: "event", event: { type: "text", text: "OK" } },
    ]);
  });

  test("maps command_execution start to tool_start", () => {
    const [parsed] = codexAdapter.parseLine(COMMAND_START_LINE);

    expect(parsed).toMatchObject({
      kind: "event",
      event: { type: "tool_start", id: "item_1", name: "command_execution" },
    });
  });

  test("maps command_execution completion to tool_end", () => {
    expect(codexAdapter.parseLine(COMMAND_DONE_LINE)).toEqual([
      {
        kind: "event",
        event: {
          type: "tool_end",
          id: "item_1",
          name: "command_execution",
          status: "finished",
        },
      },
    ]);
  });

  test("flags failed commands as errors", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "false",
        exit_code: 1,
        status: "failed",
      },
    });

    expect(codexAdapter.parseLine(line)[0]).toMatchObject({
      event: { type: "tool_end", status: "error" },
    });
  });

  test("reports turn.failed as an error result", () => {
    const line = JSON.stringify({
      type: "turn.failed",
      error: { message: "boom" },
    });

    expect(codexAdapter.parseLine(line)).toEqual([
      { kind: "result", isError: true, message: "boom" },
    ]);
  });

  test("emits usage as debug and ignores noise", () => {
    expect(codexAdapter.parseLine(USAGE_LINE)).toEqual([
      {
        kind: "event",
        event: {
          type: "debug",
          message: expect.stringContaining("output_tokens") as string,
        },
      },
    ]);
    expect(
      codexAdapter.parseLine(JSON.stringify({ type: "turn.started" })),
    ).toEqual([]);
    expect(
      codexAdapter.parseLine(
        JSON.stringify({
          type: "item.completed",
          item: { id: "r1", type: "reasoning", text: "…" },
        }),
      ),
    ).toEqual([]);
    expect(codexAdapter.parseLine("")).toEqual([]);
  });
});
