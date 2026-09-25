import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { OpenWikiLocalShellBackend } from "../../src/agent/docs-only-backend.ts";
import {
  OPENWIKI_IGNORE_FILE,
  OpenWikiIgnore,
  OpenWikiIgnoreRule,
} from "../../src/agent/openwiki-ignore.ts";

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

  const openWikiIgnore = OpenWikiIgnore.parse(`
secrets/
*.log
!logs/keep.log
`);
  const backend = new OpenWikiLocalShellBackend({
    openWikiIgnore,
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
    const rules = OpenWikiIgnore.parse(`
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

  test("canonicalizes ./ and ../ so anchored rules cannot be bypassed", () => {
    const rules = OpenWikiIgnore.parse(`
/secrets
`);

    // Baseline: the plainly-spelled path is excluded.
    expect(rules.ignores("secrets/token.txt")).toBe(true);
    expect(rules.ignores("/secrets/token.txt")).toBe(true);

    // Equivalent spellings that must resolve to the same excluded path.
    expect(rules.ignores("./secrets/token.txt")).toBe(true);
    expect(rules.ignores("secrets/../secrets/token.txt")).toBe(true);
    expect(rules.ignores("./secrets/../secrets/token.txt")).toBe(true);

    // A path that genuinely resolves elsewhere stays allowed.
    expect(rules.ignores("secrets/../public.txt")).toBe(false);
  });

  test("matches case-insensitively so alternate casing cannot bypass a rule", () => {
    const rules = OpenWikiIgnore.parse(`
secrets/
*.log
`);

    // On case-insensitive filesystems (macOS, Windows) these spellings all
    // resolve to the same excluded files, so they must all be ignored.
    expect(rules.ignores("secrets/token.txt")).toBe(true);
    expect(rules.ignores("Secrets/token.txt")).toBe(true);
    expect(rules.ignores("SECRETS/token.txt")).toBe(true);
    expect(rules.ignores("secrets/Token.TXT")).toBe(true);
    expect(rules.ignores("app/DEBUG.LOG")).toBe(true);
  });

  test("matches ** globstars spanning directories and ? single characters", () => {
    const rules = OpenWikiIgnore.parse(`
**/build/
logs/**
cache?
`);

    // `**/` spans zero or more leading directories.
    expect(rules.ignores("build/out.js")).toBe(true);
    expect(rules.ignores("a/b/build/out.js")).toBe(true);

    // A trailing bare `**` spans everything nested under the directory.
    expect(rules.ignores("logs/a/b/c.txt")).toBe(true);

    // `?` matches exactly one non-slash character - no more, no fewer.
    expect(rules.ignores("cacheX")).toBe(true);
    expect(rules.ignores("cacheXY")).toBe(false);
    expect(rules.ignores("cache")).toBe(false);
  });

  test("compile yields no rule for a pattern that is empty after stripping markers", () => {
    // A lone anchor, negation, or blank collapses to nothing and must not compile
    // into a rule that would match everything.
    expect(OpenWikiIgnoreRule.compile("/")).toBeUndefined();
    expect(OpenWikiIgnoreRule.compile("!")).toBeUndefined();
    expect(OpenWikiIgnoreRule.compile("")).toBeUndefined();

    const rules = new OpenWikiIgnore(["/", "!", ""]);
    expect(rules.isActive).toBe(false);
    expect(rules.ignores("anything")).toBe(false);
  });
});

describe("OpenWikiIgnore.load", () => {
  test("treats a missing .openwikiignore as an inactive matcher", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "openwiki-load-"));

    const ignore = await OpenWikiIgnore.load(repo);

    expect(ignore.isActive).toBe(false);
    expect(ignore.ignores("secrets/token.txt")).toBe(false);
  });

  test("parses an existing .openwikiignore into active rules", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "openwiki-load-"));
    await writeFile(
      path.join(repo, OPENWIKI_IGNORE_FILE),
      "secrets/\n*.log\n",
      "utf8",
    );

    const ignore = await OpenWikiIgnore.load(repo);

    expect(ignore.isActive).toBe(true);
    expect(ignore.patterns).toEqual(["secrets/", "*.log"]);
    expect(ignore.ignores("secrets/token.txt")).toBe(true);
  });

  test("rethrows a non-missing-file read error rather than disabling rules", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "openwiki-load-"));
    // A directory named .openwikiignore makes readFile fail with EISDIR. That is
    // not a missing-file case, so the loader must propagate it instead of silently
    // returning an inactive (fail-open) matcher.
    await mkdir(path.join(repo, OPENWIKI_IGNORE_FILE));

    await expect(OpenWikiIgnore.load(repo)).rejects.toThrow();
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

    const textGlob = await backend.glob("**/*.txt", "/");
    expect(textGlob.error).toBeUndefined();
    expect(textGlob.files?.map((file) => file.path).join("\n")).not.toContain(
      "secrets/token.txt",
    );

    const logGlob = await backend.glob("**/*.log", "/");
    expect(logGlob.error).toBeUndefined();
    expect(logGlob.files?.map((file) => file.path).join("\n")).not.toContain(
      "logs/debug.log",
    );
    expect(logGlob.files?.map((file) => file.path).join("\n")).toContain(
      "logs/keep.log",
    );

    const grep = await backend.grep("hidden-token", "/");
    expect(grep.matches).toEqual([]);
  });

  test("blocks reads of ignored paths spelled with ./ or ../", async () => {
    const { backend } = await createIgnoredRepo();

    const dotSlashRead = await backend.read("/./secrets/token.txt");
    expect(dotSlashRead.error).toContain(".openwikiignore");
    expect(dotSlashRead.content).toBeUndefined();

    const traversalRead = await backend.read("/secrets/../secrets/token.txt");
    expect(traversalRead.error).toContain(".openwikiignore");
    expect(traversalRead.content).toBeUndefined();
  });

  test("blocks reads of ignored paths spelled with different casing", async () => {
    const { backend } = await createIgnoredRepo();

    // On a case-insensitive filesystem /Secrets/token.txt resolves to the same
    // file as the excluded /secrets/token.txt, so the gate must reject it. The
    // check runs before any filesystem access, so this holds on every platform.
    const upperDirRead = await backend.read("/Secrets/token.txt");
    expect(upperDirRead.error).toContain(".openwikiignore");
    expect(upperDirRead.content).toBeUndefined();

    const upperAllRead = await backend.read("/SECRETS/TOKEN.txt");
    expect(upperAllRead.error).toContain(".openwikiignore");
    expect(upperAllRead.content).toBeUndefined();
  });

  test("refuses writes and edits to ignored paths", async () => {
    const { backend } = await createIgnoredRepo();

    const write = await backend.write("/secrets/token.txt", "overwrite\n");
    expect(write.error).toContain(".openwikiignore");

    const edit = await backend.edit(
      "/secrets/token.txt",
      "hidden-token",
      "leaked",
    );
    expect(edit.error).toContain(".openwikiignore");
  });

  test("denies uploads and downloads of ignored paths while allowing others", async () => {
    const { backend } = await createIgnoredRepo();

    const uploads = await backend.uploadFiles([
      ["secrets/token.txt", new TextEncoder().encode("x")],
      ["public.txt", new TextEncoder().encode("y")],
    ]);
    const uploadByPath = new Map(
      uploads.map((result) => [result.path, result]),
    );
    expect(uploadByPath.get("secrets/token.txt")?.error).toBe(
      "permission_denied",
    );
    expect(uploadByPath.get("public.txt")?.error).not.toBe("permission_denied");

    const downloads = await backend.downloadFiles([
      "secrets/token.txt",
      "public.txt",
    ]);
    const downloadByPath = new Map(
      downloads.map((result) => [result.path, result]),
    );
    expect(downloadByPath.get("secrets/token.txt")?.error).toBe(
      "permission_denied",
    );
    expect(downloadByPath.get("public.txt")?.error).not.toBe(
      "permission_denied",
    );
  });

  test("refuses uploads outside the docs tree in docs-only mode", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "openwiki-docsonly-"));
    const backend = new OpenWikiLocalShellBackend({
      docsOnly: true,
      maxOutputBytes: 100_000,
      outputMode: "repository",
      rootDir: repo,
      timeout: 120,
      virtualMode: true,
    });

    await backend.initialize();

    const uploads = await backend.uploadFiles([
      ["AGENTS.md", new TextEncoder().encode("x")],
      ["openwiki/notes.md", new TextEncoder().encode("y")],
    ]);
    const uploadByPath = new Map(
      uploads.map((result) => [result.path, result]),
    );

    // A write outside openwiki/ must be refused even though no .openwikiignore
    // rule matches it, mirroring the docs-only guard on write()/edit().
    expect(uploadByPath.get("AGENTS.md")?.error).toBe("permission_denied");
    expect(uploadByPath.get("openwiki/notes.md")?.error).not.toBe(
      "permission_denied",
    );
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
