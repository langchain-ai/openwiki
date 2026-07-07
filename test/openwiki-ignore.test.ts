import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { OpenWikiLocalShellBackend } from "../src/agent/docs-only-backend.ts";
import { createOpenWikiIgnoreRules } from "../src/agent/openwiki-ignore.ts";

async function createIgnoredRepo(): Promise<{
  backend: OpenWikiLocalShellBackend;
  repo: string;
}> {
  const repo = await mkdtemp(path.join(tmpdir(), "openwiki-ignore-"));

  await mkdir(path.join(repo, "logs"));
  await mkdir(path.join(repo, "secrets"));
  await writeFile(path.join(repo, "public.txt"), "visible\n", "utf8");
  await writeFile(path.join(repo, "logs", "debug.log"), "debug\n", "utf8");
  await writeFile(path.join(repo, "logs", "keep.log"), "keep\n", "utf8");
  await writeFile(
    path.join(repo, "secrets", "token.txt"),
    "hidden-token\n",
    "utf8",
  );

  const ignoreRules = createOpenWikiIgnoreRules(`
secrets/
*.log
!logs/keep.log
`);
  const backend = new OpenWikiLocalShellBackend({
    ignoreRules,
    maxOutputBytes: 100_000,
    rootDir: repo,
    timeout: 120,
    virtualMode: true,
  });

  await backend.initialize();

  return { backend, repo };
}

describe(".openwikiignore rules", () => {
  test("matches comments, directory rules, globs, negation, and root anchoring", () => {
    const rules = createOpenWikiIgnoreRules(`
# ignored paths
secrets/
*.log
!logs/keep.log
/build
`);

    expect(rules.isActive).toBe(true);
    expect(rules.ignores("secrets/token.txt")).toBe(true);
    expect(rules.ignores("src/secrets/token.txt")).toBe(true);
    expect(rules.ignores("logs/debug.log")).toBe(true);
    expect(rules.ignores("logs/keep.log")).toBe(false);
    expect(rules.ignores("build/index.js")).toBe(true);
    expect(rules.ignores("src/build/index.js")).toBe(false);
    expect(rules.ignores("src/index.ts")).toBe(false);
  });
});

describe("OpenWikiLocalShellBackend", () => {
  test("blocks direct reads and filters discovery results for ignored paths", async () => {
    const { backend } = await createIgnoredRepo();

    const publicRead = await backend.read("/public.txt");
    expect(publicRead.content).toContain("visible");

    const ignoredRead = await backend.read("/secrets/token.txt");
    expect(ignoredRead.error).toContain(".openwikiignore");

    const listing = await backend.ls("/");
    expect(listing.files?.map((file) => file.path).join("\n")).not.toContain(
      "secrets",
    );

    const glob = await backend.glob("**/*", "/");
    expect(glob.files?.map((file) => file.path).join("\n")).not.toContain(
      "secrets/token.txt",
    );
    expect(glob.files?.map((file) => file.path).join("\n")).not.toContain(
      "logs/debug.log",
    );
    expect(glob.files?.map((file) => file.path).join("\n")).toContain(
      "logs/keep.log",
    );

    const grep = await backend.grep("hidden-token", "/");
    expect(grep.matches).toEqual([]);
  });

  test("restricts shell execute while ignore rules are active", async () => {
    const { backend } = await createIgnoredRepo();

    const blocked = await backend.execute("cat secrets/token.txt");
    expect(blocked.exitCode).toBe(1);
    expect(blocked.output).toContain(".openwikiignore");

    const allowed = await backend.execute("pwd");
    expect(allowed.exitCode).toBe(0);
  });
});
