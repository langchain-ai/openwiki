import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { executeCliRun } from "../src/agent/cli-runner/index.ts";
import { claudeAdapter } from "../src/agent/cli-runner/claude.ts";
import { codexAdapter } from "../src/agent/cli-runner/codex.ts";
import type { OpenWikiRunEvent } from "../src/agent/types.ts";
import type { CliRunSpec } from "../src/agent/cli-runner/types.ts";

const SPEC: CliRunSpec = {
  command: "init",
  cwd: os.tmpdir(),
  modelId: "sonnet",
  outputMode: "repository",
  resumeSessionId: null,
  systemPrompt: "SYSTEM",
  userPrompt: "USER",
};

/**
 * Creates an executable node script that writes the given stderr text and
 * exits nonzero, ignoring stdin.
 */
async function makeFailingStubCli(
  stderr: string,
  exitCode = 2,
): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openwiki-stub-cli-"));
  const scriptPath = path.join(dir, "stub-cli");
  await writeFile(
    scriptPath,
    `#!/usr/bin/env node\nprocess.stderr.write(${JSON.stringify(stderr)});\nprocess.exit(${exitCode});\n`,
    "utf8",
  );
  await chmod(scriptPath, 0o755);

  return scriptPath;
}

/**
 * Creates an executable node script that ignores argv, echoes the given
 * stdout lines, and exits with the given code.
 */
async function makeStubCli(lines: string[], exitCode = 0): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openwiki-stub-cli-"));
  const scriptPath = path.join(dir, "stub-cli");
  const body = [
    "#!/usr/bin/env node",
    "process.stdin.resume();",
    "process.stdin.on('end', () => {",
    `  for (const line of ${JSON.stringify(lines)}) { console.log(line); }`,
    `  process.exit(${exitCode});`,
    "});",
    "process.stdin.on('data', () => {});",
  ].join("\n");

  await writeFile(scriptPath, body, "utf8");
  await chmod(scriptPath, 0o755);

  return scriptPath;
}

describe("executeCliRun", () => {
  test("streams parsed events and captures the session id", async () => {
    const stub = await makeStubCli([
      JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "hello",
      }),
    ]);
    const events: OpenWikiRunEvent[] = [];

    const result = await executeCliRun(
      claudeAdapter,
      SPEC,
      { onEvent: (event) => events.push(event) },
      stub,
    );

    expect(result.sessionId).toBe("s-1");
    expect(events.some((e) => e.type === "text" && e.text === "hello")).toBe(
      true,
    );
  });

  test("fills tool_end names from the matching tool_start", async () => {
    const stub = await makeStubCli([
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "t1", is_error: false },
          ],
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "",
      }),
    ]);
    const events: OpenWikiRunEvent[] = [];

    await executeCliRun(
      claudeAdapter,
      SPEC,
      { onEvent: (e) => events.push(e) },
      stub,
    );

    const toolEnd = events.find((e) => e.type === "tool_end");
    expect(toolEnd).toMatchObject({ name: "Bash", status: "finished" });
  });

  test("throws with stderr tail on nonzero exit", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openwiki-stub-cli-"));
    const scriptPath = path.join(dir, "stub-cli");
    await writeFile(
      scriptPath,
      "#!/usr/bin/env node\nprocess.stderr.write('login required');\nprocess.exit(2);\n",
      "utf8",
    );
    await chmod(scriptPath, 0o755);

    await expect(
      executeCliRun(claudeAdapter, SPEC, {}, scriptPath),
    ).rejects.toThrow(/exit code 2[\s\S]*login required/);
  });

  test("rejects cleanly when the CLI exits without reading a large stdin payload", async () => {
    // The stub exits immediately and never consumes stdin, so flushing a
    // payload larger than the pipe buffer hits a closed fd (EPIPE). Without
    // a stdin error handler that crashes the process instead of rejecting.
    const dir = await mkdtemp(path.join(os.tmpdir(), "openwiki-stub-cli-"));
    const scriptPath = path.join(dir, "stub-cli");
    await writeFile(
      scriptPath,
      "#!/usr/bin/env node\nprocess.stderr.write('auth failed');\nprocess.exit(2);\n",
      "utf8",
    );
    await chmod(scriptPath, 0o755);

    const largeSpec: CliRunSpec = {
      ...SPEC,
      userPrompt: "U".repeat(1024 * 1024),
    };

    await expect(
      executeCliRun(claudeAdapter, largeSpec, {}, scriptPath),
    ).rejects.toThrow(/exit code 2[\s\S]*auth failed/);
  });

  test("throws when the agent reports an error result", async () => {
    const stub = await makeStubCli([
      JSON.stringify({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        result: "too long",
      }),
    ]);

    await expect(executeCliRun(claudeAdapter, SPEC, {}, stub)).rejects.toThrow(
      /too long/,
    );
  });

  test("appends a claude login hint on an auth-flavored failure", async () => {
    const stub = await makeFailingStubCli("Error: Please log in to continue.");

    await expect(executeCliRun(claudeAdapter, SPEC, {}, stub)).rejects.toThrow(
      /claude \/login/,
    );
  });

  test("appends a codex login hint on an auth-flavored failure", async () => {
    const stub = await makeFailingStubCli("unauthorized: credentials expired");

    await expect(executeCliRun(codexAdapter, SPEC, {}, stub)).rejects.toThrow(
      /codex login/,
    );
  });

  test("does not add a login hint for non-auth failures", async () => {
    const stub = await makeFailingStubCli("write error: disk full");

    await expect(executeCliRun(claudeAdapter, SPEC, {}, stub)).rejects.toThrow(
      /disk full/,
    );
    await expect(
      executeCliRun(claudeAdapter, SPEC, {}, stub),
    ).rejects.not.toThrow(/not signed in/);
  });

  test("retries once without resume when a resumed run fails", async () => {
    const failingStub = await makeStubCli([], 1);
    const events: OpenWikiRunEvent[] = [];

    await expect(
      executeCliRun(
        claudeAdapter,
        { ...SPEC, resumeSessionId: "expired" },
        { debug: true, onEvent: (e) => events.push(e) },
        failingStub,
      ),
    ).rejects.toThrow();

    expect(
      events.some(
        (e) => e.type === "debug" && e.message.includes("resume failed"),
      ),
    ).toBe(true);
  });
});
