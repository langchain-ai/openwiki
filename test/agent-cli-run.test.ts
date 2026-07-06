import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runOpenWikiAgent } from "../src/agent/index.ts";
import type { OpenWikiRunEvent } from "../src/agent/types.ts";
import { CLAUDE_CODE_BINARY_ENV_KEY } from "../src/constants.ts";

const execFileAsync = promisify(execFile);

const DOC_WRITING_STUB = `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("0.0.0-stub");
  process.exit(0);
}
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  mkdirSync("openwiki", { recursive: true });
  writeFileSync("openwiki/quickstart.md", "# Stub docs\\n");
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "stub-session" }));
  console.log(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Docs written." }] } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }));
});
`;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function createFixtureRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "openwiki-agentcli-"));
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "OpenWiki Test"]);
  await writeFile(path.join(repo, "README.md"), "# Fixture\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

const ENV_KEYS = [
  "OPENWIKI_PROVIDER",
  "OPENWIKI_MODEL_ID",
  CLAUDE_CODE_BINARY_ENV_KEY,
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }

  const stubDir = await mkdtemp(path.join(tmpdir(), "openwiki-stub-"));
  const stubPath = path.join(stubDir, "claude-stub.mjs");
  await writeFile(stubPath, DOC_WRITING_STUB, "utf8");
  await chmod(stubPath, 0o755);

  process.env.OPENWIKI_PROVIDER = "claude-code";
  process.env.OPENWIKI_MODEL_ID = "default";
  process.env[CLAUDE_CODE_BINARY_ENV_KEY] = stubPath;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("runOpenWikiAgent with an agent-cli provider", () => {
  test("init run delegates, streams events, writes docs and metadata without an API key", async () => {
    const repo = await createFixtureRepo();
    const events: OpenWikiRunEvent[] = [];

    const result = await runOpenWikiAgent("init", repo, {
      onEvent: (event) => events.push(event),
    });

    expect(result).toEqual({ command: "init", model: "default" });
    expect(events.some((event) => event.type === "text")).toBe(true);

    const docs = await readFile(
      path.join(repo, "openwiki", "quickstart.md"),
      "utf8",
    );
    expect(docs).toContain("Stub docs");

    const metadata = JSON.parse(
      await readFile(path.join(repo, "openwiki", ".last-update.json"), "utf8"),
    ) as { command: string; model: string };
    expect(metadata.command).toBe("init");
    expect(metadata.model).toBe("default");
  }, 30_000);

  test("chat run does not write update metadata", async () => {
    const repo = await createFixtureRepo();

    const result = await runOpenWikiAgent("chat", repo, {
      userMessage: "hello",
    });

    expect(result.command).toBe("chat");
    await expect(
      readFile(path.join(repo, "openwiki", ".last-update.json"), "utf8"),
    ).rejects.toThrow();
  }, 30_000);
});
