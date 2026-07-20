import { describe, expect, test } from "vitest";
import {
  createGrokBuildStreamParser,
  DEFAULT_GROK_BUILD_MAX_TURNS,
  grokBuildAdapter,
} from "../src/agent/engines/grok-build.ts";
import type { EngineRunSpec } from "../src/agent/engines/types.ts";

const baseSpec: EngineRunSpec = {
  command: "init",
  cwd: "/tmp/repo",
  modelId: "grok-4.5",
  prompt: "Initialize docs.",
};

describe("grokBuildAdapter.buildArgs", () => {
  test("builds headless streaming-json args with prompt file and auto-approve", () => {
    expect(grokBuildAdapter.buildArgs(baseSpec, "/tmp/prompt.md")).toEqual([
      "--prompt-file",
      "/tmp/prompt.md",
      "--output-format",
      "streaming-json",
      "--always-approve",
      "--max-turns",
      String(DEFAULT_GROK_BUILD_MAX_TURNS),
      "--disable-web-search",
      "--model",
      "grok-4.5",
    ]);
  });

  test("adds --resume for follow-up sessions", () => {
    const args = grokBuildAdapter.buildArgs(
      {
        ...baseSpec,
        resumeSessionId: "sess-1",
      },
      "/tmp/prompt.md",
    );

    expect(args[args.indexOf("--resume") + 1]).toBe("sess-1");
  });
});

describe("grokBuildAdapter.detectInstall", () => {
  test("reports a missing binary", async () => {
    const status = await grokBuildAdapter.detectInstall(
      "definitely-not-a-real-binary-xyz",
    );

    expect(status.found).toBe(false);
  });

  test("reports a version for an executable that prints one", async () => {
    const status = await grokBuildAdapter.detectInstall(process.execPath);

    expect(status.found).toBe(true);
    expect(status.version).toMatch(/\d+\.\d+/);
  });
});

describe("createGrokBuildStreamParser", () => {
  test("buffers text tokens and only emits post-tool-start final text on end", () => {
    const parser = createGrokBuildStreamParser();

    expect(parser.parse({ type: "text", data: "I will inspect " })).toEqual([]);
    expect(parser.parse({ type: "text", data: "the repo." })).toEqual([]);
    expect(
      parser.parse({
        type: "tool_start",
        name: "read_file",
        id: "t1",
      }),
    ).toEqual([
      {
        type: "openwiki",
        event: {
          type: "tool_start",
          call: "read_file",
          id: "t1",
          input: undefined,
          name: "read_file",
        },
      },
    ]);

    expect(parser.parse({ type: "text", data: "Done.\n\n" })).toEqual([]);
    expect(
      parser.parse({ type: "text", data: "## Summary\nClean wiki." }),
    ).toEqual([]);

    const endEvents = parser.parse({
      type: "end",
      stopReason: "EndTurn",
      sessionId: "sess-abc",
    });

    expect(endEvents).toEqual([
      {
        type: "openwiki",
        event: {
          source: "main",
          type: "text",
          text: "Done.\n\n## Summary\nClean wiki.",
        },
      },
      { type: "session", sessionId: "sess-abc" },
      { type: "result", ok: true, errorMessage: undefined },
    ]);
  });

  test("discards pre-tool planning when tools run with no final answer", () => {
    const parser = createGrokBuildStreamParser();

    parser.parse({ type: "text", data: "planning..." });
    parser.parse({ type: "tool_start", name: "write", id: "w1" });
    parser.parse({ type: "tool_end", id: "w1", name: "write" });
    const endEvents = parser.parse({
      type: "end",
      stopReason: "EndTurn",
      sessionId: "sess-x",
    });

    expect(endEvents).toEqual([
      { type: "session", sessionId: "sess-x" },
      { type: "result", ok: true, errorMessage: undefined },
    ]);
  });

  test("keeps final answer when a trailing tool_end follows the text", () => {
    const parser = createGrokBuildStreamParser();

    parser.parse({ type: "tool_start", name: "write", id: "w1" });
    parser.parse({ type: "text", data: "Wiki ready." });
    // Trailing completion event must not wipe the answer.
    expect(parser.parse({ type: "tool_end", id: "w1", name: "write" })).toEqual(
      [
        {
          type: "openwiki",
          event: {
            type: "tool_end",
            id: "w1",
            name: "write",
            status: "finished",
          },
        },
      ],
    );

    expect(
      parser.parse({
        type: "end",
        stopReason: "EndTurn",
        sessionId: "sess-trail",
      }),
    ).toEqual([
      {
        type: "openwiki",
        event: { source: "main", type: "text", text: "Wiki ready." },
      },
      { type: "session", sessionId: "sess-trail" },
      { type: "result", ok: true, errorMessage: undefined },
    ]);
  });

  test("tool_start and tool_end share the same id fallback when ids are missing", () => {
    const parser = createGrokBuildStreamParser();

    expect(parser.parse({ type: "tool_start", name: "read" })).toEqual([
      {
        type: "openwiki",
        event: {
          type: "tool_start",
          call: "read",
          id: "read",
          input: undefined,
          name: "read",
        },
      },
    ]);

    expect(parser.parse({ type: "tool_end", name: "read" })).toEqual([
      {
        type: "openwiki",
        event: {
          type: "tool_end",
          id: "read",
          name: "read",
          status: "finished",
        },
      },
    ]);
  });

  test("thought tokens stay debug-only and do not break coalescing", () => {
    const parser = createGrokBuildStreamParser();

    expect(parser.parse({ type: "thought", data: "hmm" })).toEqual([
      {
        type: "openwiki",
        event: {
          type: "debug",
          message: 'grok-build.thought="hmm"',
        },
      },
    ]);

    parser.parse({ type: "text", data: "Final answer." });
    expect(
      parser.parse({ type: "end", stopReason: "EndTurn", sessionId: "s1" }),
    ).toEqual([
      {
        type: "openwiki",
        event: { source: "main", type: "text", text: "Final answer." },
      },
      { type: "session", sessionId: "s1" },
      { type: "result", ok: true, errorMessage: undefined },
    ]);
  });

  test("cancelled end is a failed result", () => {
    const parser = createGrokBuildStreamParser();
    const events = parser.parse({
      type: "end",
      stopReason: "Cancelled",
      sessionId: "sess-x",
    });

    expect(events).toContainEqual({ type: "session", sessionId: "sess-x" });
    expect(events).toContainEqual({
      type: "result",
      ok: false,
      errorMessage: "Grok Build run ended with stopReason=Cancelled.",
    });
  });

  test("max_turns is a failed result so partial docs are not marked complete", () => {
    const parser = createGrokBuildStreamParser();
    const events = parser.parse({
      type: "end",
      stopReason: "max_turns",
      sessionId: "sess-max",
    });

    expect(events).toContainEqual({
      type: "result",
      ok: false,
      errorMessage: "Grok Build run ended with stopReason=max_turns.",
    });
  });

  test("non-streaming final JSON blob is accepted", () => {
    const parser = createGrokBuildStreamParser();
    const events = parser.parse({
      text: "done",
      stopReason: "EndTurn",
      sessionId: "sess-final",
    });

    expect(events).toEqual([
      {
        type: "openwiki",
        event: { source: "main", type: "text", text: "done" },
      },
      { type: "session", sessionId: "sess-final" },
      { type: "result", ok: true, errorMessage: undefined },
    ]);
  });

  test("untyped mid-stream objects without stopReason are ignored", () => {
    const parser = createGrokBuildStreamParser();

    expect(parser.parse({ text: "not a final blob" })).toEqual([]);
    parser.parse({ type: "text", data: "real final" });
    expect(
      parser.parse({
        type: "end",
        stopReason: "EndTurn",
        sessionId: "s2",
      }),
    ).toEqual([
      {
        type: "openwiki",
        event: { source: "main", type: "text", text: "real final" },
      },
      { type: "session", sessionId: "s2" },
      { type: "result", ok: true, errorMessage: undefined },
    ]);
  });

  test("flush emits last buffered segment when process exits without end", () => {
    const parser = createGrokBuildStreamParser();
    parser.parse({ type: "text", data: "orphan final" });
    expect(parser.flush()).toEqual([
      {
        type: "openwiki",
        event: { source: "main", type: "text", text: "orphan final" },
      },
    ]);
    // Second flush is a no-op.
    expect(parser.flush()).toEqual([]);
  });
});
