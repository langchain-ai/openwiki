import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runOpenWikiAgent } from "../src/agent/index.ts";
import { ensureCliBinaryAvailable } from "../src/agent/cli-runner/index.ts";

const ENV_KEYS = ["OPENWIKI_PROVIDER", "PATH", "HOME"] as const;
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("cli provider routing", () => {
  test("cli provider does not require an API key env var", async () => {
    process.env.OPENWIKI_PROVIDER = "claude-code";
    // Empty PATH: the run must fail on the missing CLI binary, not on a
    // missing API key. That proves the branch skipped ensureProviderKey.
    process.env.PATH = "/nonexistent";
    // Isolated HOME so loadOpenWikiEnv cannot pick up a real ~/.openwiki/.env.
    process.env.HOME = await mkdtemp(path.join(os.tmpdir(), "openwiki-home-"));

    await expect(
      runOpenWikiAgent("chat", process.cwd(), {
        outputMode: "repository",
        userMessage: "hello",
      }),
    ).rejects.toThrow(/claude CLI not found/);
  });

  test("ensureCliBinaryAvailable names the install command", async () => {
    process.env.PATH = "/nonexistent";

    await expect(ensureCliBinaryAvailable("codex-cli")).rejects.toThrow(
      /codex CLI not found[\s\S]*@openai\/codex/,
    );
  });

  test("non-cli providers are rejected by ensureCliBinaryAvailable", async () => {
    await expect(ensureCliBinaryAvailable("openai")).rejects.toThrow(
      /not a CLI-based provider/,
    );
  });
});
