import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveStartupCommand } from "../src/startup.ts";
import type { CliCommand } from "../src/commands.ts";
import {
  OPENAI_CHATGPT_ACCESS_TOKEN_ENV_KEY,
  OPENAI_CHATGPT_ACCOUNT_ID_ENV_KEY,
  OPENAI_CHATGPT_EXPIRES_AT_ENV_KEY,
  OPENAI_CHATGPT_REFRESH_TOKEN_ENV_KEY,
  OPENROUTER_API_KEY_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
} from "../src/constants.ts";

const execFileAsync = promisify(execFile);
const MANAGED_ENV_KEYS = [
  OPENWIKI_PROVIDER_ENV_KEY,
  OPENROUTER_API_KEY_ENV_KEY,
  OPENAI_CHATGPT_ACCESS_TOKEN_ENV_KEY,
  OPENAI_CHATGPT_REFRESH_TOKEN_ENV_KEY,
  OPENAI_CHATGPT_EXPIRES_AT_ENV_KEY,
  OPENAI_CHATGPT_ACCOUNT_ID_ENV_KEY,
] as const;
const originalEnv = new Map(
  MANAGED_ENV_KEYS.map((key) => [key, process.env[key]]),
);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });

  return stdout.trim();
}

async function createRepoWithOpenWiki(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "openwiki-startup-"));
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "OpenWiki Test"]);
  await writeFile(path.join(repo, "README.md"), "# Test Repo\n", "utf8");
  await mkdir(path.join(repo, "openwiki"));
  await writeFile(
    path.join(repo, "openwiki", "quickstart.md"),
    "# Quickstart\n",
    "utf8",
  );
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

async function writeLastUpdate(repo: string, gitHead: string): Promise<void> {
  await writeFile(
    path.join(repo, "openwiki", ".last-update.json"),
    `${JSON.stringify({
      updatedAt: new Date().toISOString(),
      command: "update",
      gitHead,
      model: "test-model",
    })}\n`,
    "utf8",
  );
}

function updatePrintCommand(
  overrides: Partial<Extract<CliCommand, { kind: "run" }>> = {},
): Extract<CliCommand, { kind: "run" }> {
  return {
    kind: "run",
    exitCode: 0,
    command: "update",
    dryRun: false,
    modelId: null,
    print: true,
    shouldStart: true,
    userMessage: null,
    ...overrides,
  };
}

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function storeChatGptTokens(expiresAtMs = Date.now() + 60 * 60 * 1000): void {
  setEnv(OPENAI_CHATGPT_ACCESS_TOKEN_ENV_KEY, "access-token");
  setEnv(OPENAI_CHATGPT_REFRESH_TOKEN_ENV_KEY, "refresh-token");
  setEnv(OPENAI_CHATGPT_EXPIRES_AT_ENV_KEY, String(expiresAtMs));
  setEnv(OPENAI_CHATGPT_ACCOUNT_ID_ENV_KEY, "acct_1");
}

beforeEach(() => {
  process.env[OPENWIKI_PROVIDER_ENV_KEY] = "openrouter";
  delete process.env[OPENROUTER_API_KEY_ENV_KEY];
  delete process.env[OPENAI_CHATGPT_ACCESS_TOKEN_ENV_KEY];
  delete process.env[OPENAI_CHATGPT_REFRESH_TOKEN_ENV_KEY];
  delete process.env[OPENAI_CHATGPT_EXPIRES_AT_ENV_KEY];
  delete process.env[OPENAI_CHATGPT_ACCOUNT_ID_ENV_KEY];
});

afterEach(() => {
  for (const key of MANAGED_ENV_KEYS) {
    setEnv(key, originalEnv.get(key));
  }
});

describe("resolveStartupCommand", () => {
  test("fails fast for non-TTY interactive chat without a message", async () => {
    const result = await resolveStartupCommand(
      {
        kind: "run",
        exitCode: 0,
        command: "chat",
        dryRun: false,
        modelId: null,
        print: false,
        shouldStart: false,
        userMessage: null,
      },
      { isStdinTTY: false },
    );

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("Interactive chat requires a terminal");
    }
  });

  test("allows clean update --print no-ops without provider credentials", async () => {
    const repo = await createRepoWithOpenWiki();
    const head = await git(repo, ["rev-parse", "HEAD"]);
    await writeLastUpdate(repo, head);

    const command = updatePrintCommand();
    const result = await resolveStartupCommand(command, {
      cwd: repo,
      isStdinTTY: false,
    });

    expect(result).toBe(command);
  });

  test("still requires credentials when update --print has source changes", async () => {
    const repo = await createRepoWithOpenWiki();
    const head = await git(repo, ["rev-parse", "HEAD"]);
    await writeLastUpdate(repo, head);
    await writeFile(
      path.join(repo, "README.md"),
      "# Test Repo\nChanged\n",
      "utf8",
    );

    const result = await resolveStartupCommand(updatePrintCommand(), {
      cwd: repo,
      isStdinTTY: false,
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("OPENROUTER_API_KEY is required");
    }
  });

  test("still requires credentials when an update message is supplied", async () => {
    const repo = await createRepoWithOpenWiki();
    const head = await git(repo, ["rev-parse", "HEAD"]);
    await writeLastUpdate(repo, head);

    const result = await resolveStartupCommand(
      updatePrintCommand({ userMessage: "refresh API docs" }),
      {
        cwd: repo,
        isStdinTTY: false,
      },
    );

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("OPENROUTER_API_KEY is required");
    }
  });

  test("rejects non-interactive ChatGPT OAuth startup with incomplete tokens", async () => {
    process.env[OPENWIKI_PROVIDER_ENV_KEY] = "openai-chatgpt";
    process.env[OPENAI_CHATGPT_ACCESS_TOKEN_ENV_KEY] = "access-token";
    process.env[OPENAI_CHATGPT_EXPIRES_AT_ENV_KEY] = String(
      Date.now() + 60 * 60 * 1000,
    );

    const result = await resolveStartupCommand(
      updatePrintCommand({ userMessage: "refresh API docs" }),
      { isStdinTTY: false },
    );

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("ChatGPT OAuth token set");
      expect(result.message).toContain(OPENAI_CHATGPT_REFRESH_TOKEN_ENV_KEY);
      expect(result.message).toContain(OPENAI_CHATGPT_ACCOUNT_ID_ENV_KEY);
    }
  });

  test("allows non-interactive ChatGPT OAuth startup with complete tokens", async () => {
    process.env[OPENWIKI_PROVIDER_ENV_KEY] = "openai-chatgpt";
    storeChatGptTokens();

    const command = updatePrintCommand({ userMessage: "refresh API docs" });
    const result = await resolveStartupCommand(command, { isStdinTTY: false });

    expect(result).toBe(command);
  });

  test("leaves expired complete ChatGPT OAuth tokens to the agent refresh path", async () => {
    process.env[OPENWIKI_PROVIDER_ENV_KEY] = "openai-chatgpt";
    storeChatGptTokens(Date.now() - 60 * 1000);

    const command = updatePrintCommand({ userMessage: "refresh API docs" });
    const result = await resolveStartupCommand(command, { isStdinTTY: false });

    expect(result).toBe(command);
  });
});
