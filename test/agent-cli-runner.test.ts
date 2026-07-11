import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runAgentCli } from "../src/agent/engines/runner.ts";
import type {
  AgentCliAdapter,
  AgentCliEvent,
  EngineRunSpec,
} from "../src/agent/engines/types.ts";
import type { AgentCliProviderConfig } from "../src/constants.ts";

const originalTimeout = process.env.OPENWIKI_AGENT_CLI_TIMEOUT_SECONDS;

afterEach(() => {
  if (originalTimeout === undefined) {
    delete process.env.OPENWIKI_AGENT_CLI_TIMEOUT_SECONDS;
  } else {
    process.env.OPENWIKI_AGENT_CLI_TIMEOUT_SECONDS = originalTimeout;
  }
});

function parseFakeLine(line: unknown): AgentCliEvent[] {
  if (
    typeof line === "object" &&
    line !== null &&
    "type" in line &&
    (line as { type: string }).type === "text"
  ) {
    const data = (line as { data?: string }).data ?? "";
    return [
      {
        type: "openwiki",
        event: { source: "main", type: "text", text: data },
      },
    ];
  }

  if (
    typeof line === "object" &&
    line !== null &&
    "type" in line &&
    (line as { type: string }).type === "end"
  ) {
    const sessionId = (line as { sessionId?: string }).sessionId ?? "";
    return [
      { type: "session", sessionId },
      { type: "result", ok: true },
    ];
  }

  return [];
}

describe("runAgentCli", () => {
  test("spawns a fake CLI, forwards text events, and returns the session id", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openwiki-agent-cli-"));
    const binary = path.join(dir, "fake-grok.sh");
    await writeFile(
      binary,
      `#!/bin/sh
# Consume args; emit a minimal streaming-json success stream.
echo '{"type":"text","data":"hello from fake grok"}'
echo '{"type":"end","stopReason":"EndTurn","sessionId":"sess-test-1"}'
`,
      "utf8",
    );
    await chmod(binary, 0o755);

    const adapter: AgentCliAdapter = {
      id: "fake-grok",
      detectInstall() {
        return Promise.resolve({ found: true, version: "fake 1.0" });
      },
      buildArgs(_spec, promptFilePath) {
        return ["--prompt-file", promptFilePath];
      },
      createParser() {
        return {
          parse: parseFakeLine,
          flush: () => [],
        };
      },
    };

    const providerConfig: AgentCliProviderConfig = {
      kind: "agent-cli",
      binaryEnvKey: "OPENWIKI_TEST_FAKE_GROK_BINARY",
      defaultBinary: binary,
      installHint: "install fake",
      label: "Fake Grok",
      modelOptions: [{ id: "fake", label: "Fake" }],
    };

    process.env.OPENWIKI_AGENT_CLI_TIMEOUT_SECONDS = "30";

    const events: string[] = [];
    const spec: EngineRunSpec = {
      command: "chat",
      cwd: dir,
      modelId: "fake",
      prompt: "hello",
    };

    const outcome = await runAgentCli(adapter, providerConfig, spec, {
      onEvent: (event) => {
        if (event.type === "text") {
          events.push(event.text);
        }
      },
    });

    expect(outcome.sessionId).toBe("sess-test-1");
    expect(events.join("")).toContain("hello from fake grok");
  });

  test("throws a clear error when the binary is missing", async () => {
    const adapter: AgentCliAdapter = {
      id: "missing",
      detectInstall() {
        return Promise.resolve({ found: false });
      },
      buildArgs() {
        return [];
      },
      createParser() {
        return {
          parse: () => [],
          flush: () => [],
        };
      },
    };

    const providerConfig: AgentCliProviderConfig = {
      kind: "agent-cli",
      binaryEnvKey: "OPENWIKI_TEST_MISSING_BINARY",
      defaultBinary: "missing-binary",
      installHint: "Install the thing.",
      label: "Missing CLI",
      modelOptions: [],
    };

    await expect(
      runAgentCli(
        adapter,
        providerConfig,
        {
          command: "chat",
          cwd: process.cwd(),
          modelId: "x",
          prompt: "hi",
        },
        {},
      ),
    ).rejects.toThrow(/Install the thing/);
  });
});
