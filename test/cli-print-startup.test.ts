import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { CLAUDE_CODE_BINARY_ENV_KEY } from "../src/constants.ts";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const CLI_ENTRY = path.join(REPO_ROOT, "src", "cli.tsx");

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
  const repo = await mkdtemp(path.join(tmpdir(), "openwiki-cli-print-"));
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "OpenWiki Test"]);
  await writeFile(path.join(repo, "README.md"), "# Fixture\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

describe("cli.tsx --print startup with an agent-cli provider", () => {
  test("does not require a provider API key env var to run --print --init", async () => {
    const repo = await createFixtureRepo();
    const stubDir = await mkdtemp(path.join(tmpdir(), "openwiki-cli-stub-"));
    const stubPath = path.join(stubDir, "claude-stub.mjs");
    await writeFile(stubPath, DOC_WRITING_STUB, "utf8");
    await chmod(stubPath, 0o755);

    const env = {
      ...process.env,
      OPENWIKI_PROVIDER: "claude-code",
      OPENWIKI_MODEL_ID: "default",
      [CLAUDE_CODE_BINARY_ENV_KEY]: stubPath,
    };
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENROUTER_API_KEY;
    delete env.OPENAI_API_KEY;
    delete env.BASETEN_API_KEY;
    delete env.FIREWORKS_API_KEY;
    delete env.OPENAI_COMPATIBLE_API_KEY;

    await expect(
      execFileAsync(TSX_BIN, [CLI_ENTRY, "--print", "--init"], {
        cwd: repo,
        env,
      }),
    ).resolves.not.toThrow();

    const docs = await readFile(
      path.join(repo, "openwiki", "quickstart.md"),
      "utf8",
    );
    expect(docs).toContain("Stub docs");
  }, 30_000);
});
