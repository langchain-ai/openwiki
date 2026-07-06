import { describe, expect, test } from "vitest";
import {
  IBM_BOB_ALLOWED_TOOLS,
  ibmBobAdapter,
} from "../src/agent/engines/ibm-bob.ts";
import type { EngineRunSpec } from "../src/agent/engines/types.ts";

const baseSpec: EngineRunSpec = {
  command: "init",
  cwd: "/tmp/repo",
  modelId: "default",
  prompt: "Initialize docs.",
  systemPrompt: "You are OpenWiki.",
};

describe("ibmBobAdapter.buildArgs", () => {
  test("builds headless stream-json args with pinned approval and chat modes", () => {
    expect(ibmBobAdapter.buildArgs(baseSpec)).toEqual([
      "--output-format",
      "stream-json",
      "--approval-mode",
      "auto_edit",
      "--chat-mode",
      "advanced",
      "--allowed-tools",
      IBM_BOB_ALLOWED_TOOLS,
    ]);
  });

  test("omits --model for the subscription default and adds it otherwise", () => {
    expect(ibmBobAdapter.buildArgs(baseSpec)).not.toContain("--model");

    const args = ibmBobAdapter.buildArgs({
      ...baseSpec,
      modelId: "granite-3-3-8b-instruct",
    });

    expect(args[args.indexOf("--model") + 1]).toBe("granite-3-3-8b-instruct");
  });

  test("adds --resume for follow-up sessions", () => {
    const args = ibmBobAdapter.buildArgs({
      ...baseSpec,
      resumeSessionId: "bob-sess-1",
    });

    expect(args[args.indexOf("--resume") + 1]).toBe("bob-sess-1");
    expect(args).toContain("-p");
    expect(args[args.indexOf("-p") + 1]).toBe(
      "You are OpenWiki.\n\nInitialize docs.",
    );
  });

  test("never passes the prompt as an argument", () => {
    const args = ibmBobAdapter.buildArgs(baseSpec);

    expect(args).not.toContain("-p");
    expect(args).not.toContain(baseSpec.prompt);
    expect(args).not.toContain(baseSpec.systemPrompt);
  });

  test("allowed tools stay documentation-shaped", () => {
    const tools = IBM_BOB_ALLOWED_TOOLS.split(",");

    expect(tools).toContain("run_shell_command(git log)");
    expect(tools).toContain("run_shell_command(rm -f openwiki/_plan.md)");
    expect(IBM_BOB_ALLOWED_TOOLS).not.toContain("web_fetch");
    expect(IBM_BOB_ALLOWED_TOOLS).not.toContain("google_web_search");
  });
});

describe("ibmBobAdapter.buildStdin", () => {
  test("prepends the system prompt to the user prompt", () => {
    expect(ibmBobAdapter.buildStdin?.(baseSpec)).toBe(
      "You are OpenWiki.\n\nInitialize docs.",
    );
  });

  test("returns an empty string when resuming, since -p carries the payload", () => {
    expect(
      ibmBobAdapter.buildStdin?.({
        ...baseSpec,
        resumeSessionId: "bob-sess-1",
      }),
    ).toBe("");
  });
});

describe("ibmBobAdapter.detectInstall", () => {
  test("reports a missing binary", async () => {
    const status = await ibmBobAdapter.detectInstall(
      "definitely-not-a-real-binary-xyz",
    );

    expect(status.found).toBe(false);
  });

  test("reports a version for an executable that prints one", async () => {
    const status = await ibmBobAdapter.detectInstall(process.execPath);

    expect(status.found).toBe(true);
    expect(status.version).toMatch(/\d+\.\d+/);
  });
});

describe("ibmBobAdapter.parseEvent", () => {
  test("init yields a session event and a debug event", () => {
    const events = ibmBobAdapter.parseEvent({
      type: "init",
      timestamp: "2026-07-06T00:00:00.000Z",
      session_id: "3f6b1a2c-0000-0000-0000-000000000000",
      model: "bob-default",
    });

    expect(events).toEqual([
      {
        type: "session",
        sessionId: "3f6b1a2c-0000-0000-0000-000000000000",
      },
      {
        type: "openwiki",
        event: {
          type: "debug",
          message: "ibm-bob session initialized model=bob-default",
        },
      },
    ]);
  });

  test("assistant message deltas become text events", () => {
    const events = ibmBobAdapter.parseEvent({
      type: "message",
      timestamp: "2026-07-06T00:00:00.000Z",
      role: "assistant",
      content: "Working on it.",
      delta: true,
    });

    expect(events).toEqual([
      {
        type: "openwiki",
        event: { source: "main", type: "text", text: "Working on it." },
      },
    ]);
  });

  test("user message echoes are ignored", () => {
    expect(
      ibmBobAdapter.parseEvent({
        type: "message",
        timestamp: "2026-07-06T00:00:00.000Z",
        role: "user",
        content: "Initialize docs.",
      }),
    ).toEqual([]);
  });

  test("tool_use becomes a tool_start event", () => {
    const events = ibmBobAdapter.parseEvent({
      type: "tool_use",
      timestamp: "2026-07-06T00:00:00.000Z",
      tool_name: "write_to_file",
      tool_id: "bob-tool-1",
      parameters: { path: "openwiki/quickstart.md" },
    });

    expect(events).toEqual([
      {
        type: "openwiki",
        event: {
          type: "tool_start",
          call: 'write_to_file(path="openwiki/quickstart.md")',
          id: "bob-tool-1",
          input: { path: "openwiki/quickstart.md" },
          name: "write_to_file",
        },
      },
    ]);
  });

  test("tool_result becomes a tool_end event with status mapping", () => {
    const ok = ibmBobAdapter.parseEvent({
      type: "tool_result",
      timestamp: "2026-07-06T00:00:00.000Z",
      tool_id: "bob-tool-1",
      status: "success",
      output: "written",
    });
    const failed = ibmBobAdapter.parseEvent({
      type: "tool_result",
      timestamp: "2026-07-06T00:00:00.000Z",
      tool_id: "bob-tool-2",
      status: "error",
      output: "denied",
      error: { type: "TOOL_EXECUTION_ERROR", message: "denied" },
    });

    expect(ok).toEqual([
      {
        type: "openwiki",
        event: {
          type: "tool_end",
          id: "bob-tool-1",
          name: "tool",
          status: "finished",
        },
      },
    ]);
    expect(failed).toEqual([
      {
        type: "openwiki",
        event: {
          type: "tool_end",
          id: "bob-tool-2",
          name: "tool",
          status: "error",
        },
      },
    ]);
  });

  test("error events become debug events", () => {
    expect(
      ibmBobAdapter.parseEvent({
        type: "error",
        timestamp: "2026-07-06T00:00:00.000Z",
        severity: "warning",
        message: "Loop detected, stopping execution",
      }),
    ).toEqual([
      {
        type: "openwiki",
        event: {
          type: "debug",
          message: "ibm-bob warning: Loop detected, stopping execution",
        },
      },
    ]);
  });

  test("result events map success and error statuses", () => {
    expect(
      ibmBobAdapter.parseEvent({
        type: "result",
        timestamp: "2026-07-06T00:00:00.000Z",
        status: "success",
        stats: {},
      }),
    ).toEqual([{ type: "result", ok: true, errorMessage: undefined }]);

    expect(
      ibmBobAdapter.parseEvent({
        type: "result",
        timestamp: "2026-07-06T00:00:00.000Z",
        status: "error",
        error: {
          type: "FatalToolExecutionError",
          message: "Authentication timeout (3 minutes)",
        },
        stats: {},
      }),
    ).toEqual([
      {
        type: "result",
        ok: false,
        errorMessage: "Authentication timeout (3 minutes)",
      },
    ]);
  });

  test("a result error without a message gets a readable fallback", () => {
    expect(
      ibmBobAdapter.parseEvent({
        type: "result",
        timestamp: "2026-07-06T00:00:00.000Z",
        status: "error",
        stats: {},
      }),
    ).toEqual([
      {
        type: "result",
        ok: false,
        errorMessage: "IBM Bob run ended with error.",
      },
    ]);
  });

  test("unknown lines are ignored", () => {
    expect(ibmBobAdapter.parseEvent("not json-shaped")).toEqual([]);
    expect(ibmBobAdapter.parseEvent({ type: "mystery" })).toEqual([]);
    expect(ibmBobAdapter.parseEvent(null)).toEqual([]);
  });
});
