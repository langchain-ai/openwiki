import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createGitReadOnlyTools } from "../src/agent/tools/git-tools.ts";
import { runGitCommand } from "../src/agent/tools/shared/git-exec.ts";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

function getTool(
  tools: StructuredToolInterface[],
  name: string,
): StructuredToolInterface {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Tool not found: ${name}`);
  }

  return tool;
}

async function invoke(
  tools: StructuredToolInterface[],
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  const result = await getTool(tools, name).invoke(input);

  return typeof result === "string" ? result : JSON.stringify(result);
}

describe("createGitReadOnlyTools", () => {
  let repoDir: string;
  let tools: StructuredToolInterface[];

  beforeAll(async () => {
    repoDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-git-tools-"));
    git(repoDir, ["init", "--quiet"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test User"]);

    await writeFile(path.join(repoDir, "README.md"), "# Title\nfirst line\n");
    git(repoDir, ["add", "README.md"]);
    git(repoDir, ["commit", "--quiet", "-m", "initial commit"]);

    await writeFile(
      path.join(repoDir, "README.md"),
      "# Title\nfirst line\nsecond line\n",
    );
    git(repoDir, ["add", "README.md"]);
    git(repoDir, ["commit", "--quiet", "-m", "second commit"]);

    tools = createGitReadOnlyTools({ cwd: repoDir });
  });

  afterAll(() => {
    // Temp directories are cleaned up by the OS; nothing persistent to remove.
  });

  test("git_log returns recent commits", async () => {
    const output = await invoke(tools, "openwiki_git_log", { maxCount: 10 });
    expect(output).toContain("initial commit");
    expect(output).toContain("second commit");
  });

  test("git_log filters by file path", async () => {
    const output = await invoke(tools, "openwiki_git_log", {
      filePath: "README.md",
    });
    expect(output).toContain("second commit");
  });

  test("git_show returns file content at a ref", async () => {
    const output = await invoke(tools, "openwiki_git_show", {
      ref: "HEAD",
      filePath: "README.md",
    });
    expect(output).toContain("second line");
  });

  test("git_blame returns authorship for a line range", async () => {
    const output = await invoke(tools, "openwiki_git_blame", {
      filePath: "README.md",
      startLine: 1,
      endLine: 2,
    });
    expect(output).toContain("Test User");
  });

  test("git_status reports untracked files", async () => {
    await writeFile(path.join(repoDir, "untracked.txt"), "hello\n");
    const output = await invoke(tools, "openwiki_git_status", {});
    expect(output).toContain("untracked.txt");
  });

  test("git_diff shows uncommitted changes", async () => {
    await writeFile(
      path.join(repoDir, "README.md"),
      "# Title\nfirst line\nsecond line\nthird line\n",
    );
    const output = await invoke(tools, "openwiki_git_diff", {
      filePath: "README.md",
    });
    expect(output).toContain("third line");

    // Restore committed content so later assertions stay deterministic.
    await writeFile(
      path.join(repoDir, "README.md"),
      "# Title\nfirst line\nsecond line\n",
    );
  });

  test("rejects path traversal in filePath", async () => {
    const output = await invoke(tools, "openwiki_git_show", {
      ref: "HEAD",
      filePath: "../etc/passwd",
    });
    expect(output).toContain("'..'");
  });

  test("rejects unsafe git refs", async () => {
    const output = await invoke(tools, "openwiki_git_show", {
      ref: "main; rm -rf /",
    });
    expect(output).toContain("Refused unsafe git ref");
  });

  test("rejects branch-name refs that are not hex or HEAD-relative", async () => {
    const output = await invoke(tools, "openwiki_git_diff", {
      ref: "feature-branch",
    });
    expect(output).toContain("Refused unsafe git ref");
  });

  test("returns an error for a non-git directory", async () => {
    const nonGitDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-nongit-"));
    const nonGitTools = createGitReadOnlyTools({ cwd: nonGitDir });
    const output = await invoke(nonGitTools, "openwiki_git_status", {});
    expect(output.toLowerCase()).toContain("git error");
  });

  test("truncates very large output", async () => {
    const bigRepo = await mkdtemp(path.join(os.tmpdir(), "openwiki-git-big-"));
    git(bigRepo, ["init", "--quiet"]);
    git(bigRepo, ["config", "user.email", "test@example.com"]);
    git(bigRepo, ["config", "user.name", "Test User"]);
    await writeFile(
      path.join(bigRepo, "big.txt"),
      `${"x".repeat(150_000)}\n`,
    );
    git(bigRepo, ["add", "big.txt"]);
    git(bigRepo, ["commit", "--quiet", "-m", "big file"]);

    const bigTools = createGitReadOnlyTools({ cwd: bigRepo });
    const output = await invoke(bigTools, "openwiki_git_show", {
      ref: "HEAD",
      filePath: "big.txt",
    });
    expect(output).toContain("[output truncated]");
  });

  test("rejects a symlink that points outside the repository root", async () => {
    const outsideDir = await mkdtemp(
      path.join(os.tmpdir(), "openwiki-outside-"),
    );
    await writeFile(path.join(outsideDir, "secret.txt"), "secret\n");

    const linkPath = path.join(repoDir, "link-to-secret");
    try {
      await symlink(path.join(outsideDir, "secret.txt"), linkPath);
    } catch {
      // Symlink creation can require elevated privileges on some platforms.
      return;
    }

    const output = await invoke(tools, "openwiki_git_show", {
      ref: "HEAD",
      filePath: "link-to-secret",
    });
    expect(output.toLowerCase()).toContain("symlink");
  });
});

describe("runGitCommand", () => {
  test("captures errors for invalid subcommands", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openwiki-git-err-"));
    await mkdir(dir, { recursive: true });
    const result = await runGitCommand(dir, ["status"]);
    expect(result.error).toBeDefined();
  });
});
