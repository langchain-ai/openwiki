import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  getAgentCliProviderConfig,
  CLAUDE_CODE_BINARY_ENV_KEY,
} from "../src/constants.ts";
import { claudeCodeAdapter } from "../src/agent/engines/claude-code.ts";
import { getAgentCliAdapter } from "../src/agent/engines/index.ts";
import {
  getLiveProcessGroupIdsForTesting,
  getThreadSessionId,
  runAgentCli,
  setThreadSessionId,
} from "../src/agent/engines/runner.ts";
import type { EngineRunSpec } from "../src/agent/engines/types.ts";
import type { OpenWikiRunEvent } from "../src/agent/types.ts";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const RUNNER_MODULE_PATH = path.join(
  REPO_ROOT,
  "src",
  "agent",
  "engines",
  "runner.ts",
);
const CLAUDE_CODE_ADAPTER_MODULE_PATH = path.join(
  REPO_ROOT,
  "src",
  "agent",
  "engines",
  "claude-code.ts",
);
const CONSTANTS_MODULE_PATH = path.join(REPO_ROOT, "src", "constants.ts");

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

// Writes its own pid to OPENWIKI_TEST_PID_FILE before hanging, so an outside
// process can identify and check on the detached grandchild.
const HANG_STUB_WITH_PID = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("0.0.0-stub");
  process.exit(0);
}
writeFileSync(process.env.OPENWIKI_TEST_PID_FILE, String(process.pid));
setInterval(() => {}, 1000);
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

/**
 * Source for a standalone script (run via tsx as a real, separate OS process)
 * that starts a detached agent-cli run against a hang stub and then exits
 * without ever awaiting or otherwise cleaning up that run — mirroring a crash
 * or a forceful kill of the OpenWiki process while a run is in flight. The
 * outside test spawns this as a child, lets it exit, and then checks whether
 * the grandchild (the hang stub) was cleaned up.
 */
function buildOrphanCheckWrapperSource(): string {
  return `
import { existsSync } from "node:fs";
import { runAgentCli } from ${JSON.stringify(RUNNER_MODULE_PATH)};
import { claudeCodeAdapter } from ${JSON.stringify(CLAUDE_CODE_ADAPTER_MODULE_PATH)};
import { getAgentCliProviderConfig } from ${JSON.stringify(CONSTANTS_MODULE_PATH)};

const spec = {
  command: "init",
  cwd: process.cwd(),
  modelId: "default",
  prompt: "hang please",
  systemPrompt: "sys",
};

runAgentCli(
  claudeCodeAdapter,
  getAgentCliProviderConfig("claude-code"),
  spec,
  {},
).catch(() => {});

const pidFile = process.env.OPENWIKI_TEST_PID_FILE;

// Failsafe: if the stub never manages to start (and write its pid file),
// don't hang the outer test forever.
setTimeout(() => {
  process.exit(1);
}, 5000).unref();

(function poll() {
  if (pidFile && existsSync(pidFile)) {
    process.exit(0);
    return;
  }
  setTimeout(poll, 50);
})();
`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }

    await delay(50);
  }

  return !isProcessAlive(pid);
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

  test("tracks the child's process group while live and untracks it once the run closes", async () => {
    process.env[CLAUDE_CODE_BINARY_ENV_KEY] = await writeStub(
      stubDir,
      "stub-hang-tracking",
      HANG_STUB,
    );
    process.env.OPENWIKI_AGENT_CLI_TIMEOUT_SECONDS = "1";

    expect(getLiveProcessGroupIdsForTesting().size).toBe(0);

    const runPromise = runAgentCli(
      claudeCodeAdapter,
      getAgentCliProviderConfig("claude-code"),
      baseSpec,
      {},
    );

    const deadline = Date.now() + 2000;
    while (
      getLiveProcessGroupIdsForTesting().size === 0 &&
      Date.now() < deadline
    ) {
      await delay(20);
    }

    expect(getLiveProcessGroupIdsForTesting().size).toBe(1);

    await expect(runPromise).rejects.toThrow(/timed out after 1 seconds/);
    expect(getLiveProcessGroupIdsForTesting().size).toBe(0);
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

  test("sends the adapter-composed stdin payload when buildStdin is present", async () => {
    process.env[CLAUDE_CODE_BINARY_ENV_KEY] = await writeStub(
      stubDir,
      "stub-stdin",
      SUCCESS_STUB,
    );
    const events: OpenWikiRunEvent[] = [];
    const adapterWithStdin = {
      ...claudeCodeAdapter,
      buildStdin: (spec: EngineRunSpec) =>
        `${spec.systemPrompt}\n\n${spec.prompt}`,
    };

    await runAgentCli(
      adapterWithStdin,
      getAgentCliProviderConfig("claude-code"),
      baseSpec,
      { onEvent: (event) => events.push(event) },
    );

    const expectedBytes = `${baseSpec.systemPrompt}\n\n${baseSpec.prompt}`
      .length;
    const text = events.find((event) => event.type === "text");
    expect(text).toMatchObject({ text: `prompt-bytes:${expectedBytes}` });
  });
});

describe("thread session map", () => {
  test("stores and retrieves vendor session ids by thread id", () => {
    expect(getThreadSessionId("thread-x")).toBeUndefined();
    setThreadSessionId("thread-x", "sess-1");
    expect(getThreadSessionId("thread-x")).toBe("sess-1");
  });
});

describe("detached process-group cleanup on process exit", () => {
  test("kills the vendor CLI's process group when the parent process exits mid-run", async () => {
    const pidFile = path.join(stubDir, "grandchild.pid");
    process.env[CLAUDE_CODE_BINARY_ENV_KEY] = await writeStub(
      stubDir,
      "stub-hang-orphan",
      HANG_STUB_WITH_PID,
    );

    const wrapperPath = path.join(stubDir, "orphan-check-wrapper.ts");
    await writeFile(wrapperPath, buildOrphanCheckWrapperSource(), "utf8");

    // Runs a separate Node process (via tsx) that starts a detached run
    // against the hang stub and then calls process.exit() without awaiting
    // or cancelling that run -- simulating the parent OpenWiki process being
    // killed or crashing mid-run. If the runner's exit handler is missing or
    // broken, the stub keeps running as an orphan under init.
    await execFileAsync(TSX_BIN, [wrapperPath], {
      cwd: stubDir,
      env: {
        ...process.env,
        OPENWIKI_TEST_PID_FILE: pidFile,
      },
      timeout: 15_000,
    });

    const grandchildPid = Number.parseInt(
      (await readFile(pidFile, "utf8")).trim(),
      10,
    );
    expect(Number.isInteger(grandchildPid)).toBe(true);

    const died = await waitForProcessExit(grandchildPid, 3000);
    expect(died).toBe(true);
  }, 20_000);
});
