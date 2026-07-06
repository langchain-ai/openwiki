import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  getAgentCliProviderConfig,
  CLAUDE_CODE_BINARY_ENV_KEY,
} from "../src/constants.ts";
import { claudeCodeAdapter } from "../src/agent/engines/claude-code.ts";
import { getAgentCliAdapter } from "../src/agent/engines/index.ts";
import {
  getThreadSessionId,
  runAgentCli,
  setThreadSessionId,
} from "../src/agent/engines/runner.ts";
import type { EngineRunSpec } from "../src/agent/engines/types.ts";
import type { OpenWikiRunEvent } from "../src/agent/types.ts";

const SUCCESS_STUB = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("0.0.0-stub");
  process.exit(0);
}
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "stub-session", model: "stub-model" }));
  console.log(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
    { type: "text", text: "prompt-bytes:" + input.length },
    { type: "tool_use", id: "tool-1", name: "Write", input: { file_path: "openwiki/quickstart.md" } },
  ] } }));
  console.log("not-json noise line");
  console.log(JSON.stringify({ type: "user", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "tool-1", is_error: false },
  ] } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }));
});
`;

const FAILURE_STUB = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("0.0.0-stub");
  process.exit(0);
}
process.stdin.resume();
process.stdin.on("end", () => {
  console.error("stderr detail: login expired");
  console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "Invalid API key" }));
  process.exit(1);
});
`;

const HANG_STUB = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("0.0.0-stub");
  process.exit(0);
}
setInterval(() => {}, 1000);
`;

const EXIT_WITHOUT_READING_STDIN_STUB = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("0.0.0-stub");
  process.exit(0);
}
process.exit(0);
`;

async function writeStub(
  dir: string,
  name: string,
  content: string,
): Promise<string> {
  const stubPath = path.join(dir, name);
  await writeFile(stubPath, content, "utf8");
  await chmod(stubPath, 0o755);
  return stubPath;
}

const baseSpec: EngineRunSpec = {
  command: "init",
  cwd: process.cwd(),
  modelId: "default",
  prompt: "Initialize docs.",
  systemPrompt: "You are OpenWiki.",
};

let stubDir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  stubDir = await mkdtemp(path.join(tmpdir(), "openwiki-stub-"));
  for (const key of [
    CLAUDE_CODE_BINARY_ENV_KEY,
    "OPENWIKI_AGENT_CLI_TIMEOUT_SECONDS",
  ]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("getAgentCliAdapter", () => {
  test("returns the claude-code adapter and rejects api providers", () => {
    expect(getAgentCliAdapter("claude-code")).toBe(claudeCodeAdapter);
    expect(() => getAgentCliAdapter("openai")).toThrow(/openai/);
  });
});

describe("runAgentCli", () => {
  test("forwards events in order, patches tool_end names, and captures the session", async () => {
    process.env[CLAUDE_CODE_BINARY_ENV_KEY] = await writeStub(
      stubDir,
      "stub-ok",
      SUCCESS_STUB,
    );
    const events: OpenWikiRunEvent[] = [];

    const outcome = await runAgentCli(
      claudeCodeAdapter,
      getAgentCliProviderConfig("claude-code"),
      baseSpec,
      { onEvent: (event) => events.push(event) },
    );

    expect(outcome.sessionId).toBe("stub-session");
    const types = events.map((event) => event.type);
    expect(types).toContain("text");
    expect(types).toContain("tool_start");
    expect(types).toContain("tool_end");
    const toolEnd = events.find((event) => event.type === "tool_end");
    expect(toolEnd).toMatchObject({
      id: "tool-1",
      name: "Write",
      status: "finished",
    });
    const text = events.find((event) => event.type === "text");
    expect(text).toMatchObject({
      text: `prompt-bytes:${baseSpec.prompt.length}`,
    });
  });

  test("throws the vendor error message with the stderr tail on failure", async () => {
    process.env[CLAUDE_CODE_BINARY_ENV_KEY] = await writeStub(
      stubDir,
      "stub-fail",
      FAILURE_STUB,
    );

    await expect(
      runAgentCli(
        claudeCodeAdapter,
        getAgentCliProviderConfig("claude-code"),
        baseSpec,
        {},
      ),
    ).rejects.toThrow(/Invalid API key[\s\S]*login expired/);
  });

  test("throws an actionable install hint when the binary is missing", async () => {
    process.env[CLAUDE_CODE_BINARY_ENV_KEY] = path.join(
      stubDir,
      "does-not-exist",
    );

    await expect(
      runAgentCli(
        claudeCodeAdapter,
        getAgentCliProviderConfig("claude-code"),
        baseSpec,
        {},
      ),
    ).rejects.toThrow(/Install Claude Code/);
  });

  test("kills a hung run after the configured timeout", async () => {
    process.env[CLAUDE_CODE_BINARY_ENV_KEY] = await writeStub(
      stubDir,
      "stub-hang",
      HANG_STUB,
    );
    process.env.OPENWIKI_AGENT_CLI_TIMEOUT_SECONDS = "1";

    await expect(
      runAgentCli(
        claudeCodeAdapter,
        getAgentCliProviderConfig("claude-code"),
        baseSpec,
        {},
      ),
    ).rejects.toThrow(/timed out after 1 seconds/);
  }, 15_000);

  test("rejects instead of crashing when the child exits without reading a large prompt", async () => {
    process.env[CLAUDE_CODE_BINARY_ENV_KEY] = await writeStub(
      stubDir,
      "stub-exit-early",
      EXIT_WITHOUT_READING_STDIN_STUB,
    );

    await expect(
      runAgentCli(
        claudeCodeAdapter,
        getAgentCliProviderConfig("claude-code"),
        { ...baseSpec, prompt: "x".repeat(1024 * 1024) },
        {},
      ),
    ).rejects.toThrow(/run failed/);
  });
});

describe("thread session map", () => {
  test("stores and retrieves vendor session ids by thread id", () => {
    expect(getThreadSessionId("thread-x")).toBeUndefined();
    setThreadSessionId("thread-x", "sess-1");
    expect(getThreadSessionId("thread-x")).toBe("sess-1");
  });
});
