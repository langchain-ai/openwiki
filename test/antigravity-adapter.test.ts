import { describe, expect, test } from "vitest";
import {
  createAntigravityAdapter,
  extractConversationId,
  extractProviderError,
  formatPrintTimeout,
} from "../src/agent/engines/antigravity.ts";
import type { EngineRunSpec } from "../src/agent/engines/types.ts";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

describe("antigravity adapter helpers", () => {
  test("extractConversationId returns the last conversation uuid", () => {
    const log = `
I0528 13:36:23.318877 73304 printmode.go:130] Print mode: conversation=b8b263a4-4b2f-4339-acc9-78b248e2b606, sending message
I0528 13:36:24.000000 73304 printmode.go:130] Print mode: conversation=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee, sending message
`;

    expect(extractConversationId(log)).toBe(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );
  });

  test("extractConversationId returns undefined when absent", () => {
    expect(extractConversationId("no conversation here")).toBeUndefined();
  });

  test("extractProviderError returns the last agent executor error", () => {
    const log = `
E0623 agent executor error: rate limited
E0623 agent executor error: model overloaded
`;

    expect(extractProviderError(log)).toBe("model overloaded");
  });

  test("formatPrintTimeout renders m/s form", () => {
    expect(formatPrintTimeout(1800)).toBe("30m0s");
    expect(formatPrintTimeout(90)).toBe("1m30s");
    expect(formatPrintTimeout(0)).toBe("0m1s");
  });
});

describe("createAntigravityAdapter", () => {
  test("buildArgs uses -p, skip-permissions, log-file, and model display name", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openwiki-agy-"));
    const promptFile = path.join(dir, "prompt.md");
    await writeFile(promptFile, "document the repo", "utf8");

    const adapter = createAntigravityAdapter();
    const spec: EngineRunSpec = {
      command: "init",
      cwd: dir,
      prompt: "document the repo",
      modelId: "Gemini 3.5 Flash (Medium)",
      resumeSessionId: "b8b263a4-4b2f-4339-acc9-78b248e2b606",
    };

    const args = adapter.buildArgs(spec, promptFile);

    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("document the repo");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--mode");
    expect(args).toContain("accept-edits");
    expect(args).toContain("--model");
    expect(args).toContain("Gemini 3.5 Flash (Medium)");
    expect(args).toContain("--conversation");
    expect(args).toContain("b8b263a4-4b2f-4339-acc9-78b248e2b606");
    expect(args).toContain("--log-file");
    expect(args).toContain("--add-dir");
    expect(args).toContain(path.resolve(dir));

    await adapter.cleanup?.();
  });

  test("text parser emits openwiki text events and afterExit synthesizes success", async () => {
    const adapter = createAntigravityAdapter();
    const parser = adapter.createParser();

    expect(parser.parse("Hello from agy")).toEqual([
      {
        type: "openwiki",
        event: { source: "main", type: "text", text: "Hello from agy\n" },
      },
    ]);

    const events = await adapter.afterExit?.({
      exitCode: 0,
      stderrTail: "",
    });

    expect(events).toEqual([{ type: "result", ok: true }]);
    await adapter.cleanup?.();
  });

  test("afterExit reports timeout from log contents", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openwiki-agy-"));
    const promptFile = path.join(dir, "prompt.md");
    await writeFile(promptFile, "hi", "utf8");

    const adapter = createAntigravityAdapter();
    const args = adapter.buildArgs(
      {
        command: "chat",
        cwd: dir,
        prompt: "hi",
        modelId: "Gemini 3.5 Flash (Medium)",
      },
      promptFile,
    );
    const logFile = args[args.indexOf("--log-file") + 1];
    await writeFile(
      logFile,
      "E0623 17:17:59.017212 65926 printmode.go:289] Print mode: timed out after 100 polls (printed=3)\n",
      "utf8",
    );

    const events = await adapter.afterExit?.({
      exitCode: 0,
      stderrTail: "",
    });

    expect(events?.some((event) => event.type === "result" && !event.ok)).toBe(
      true,
    );
    await adapter.cleanup?.();
  });
});
