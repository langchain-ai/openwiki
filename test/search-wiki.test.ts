import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { getHelpText, parseCommand } from "../src/commands.ts";
import { searchWiki, tokenizeQuery } from "../src/search/search-wiki.ts";
import {
  resolveWikiRoot,
  virtualRootForRunMode,
} from "../src/search/resolve-wiki-root.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  // Best-effort cleanup; tests should not depend on leftover fixtures.
  for (const dir of tempDirs.splice(0)) {
    try {
      const { rm } = await import("node:fs/promises");
      await rm(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

async function createFixtureWiki(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-search-"));
  tempDirs.push(root);
  await mkdir(path.join(root, "topics"), { recursive: true });
  await writeFile(
    path.join(root, "topics", "deepagents-harness.md"),
    [
      "# Deep Agents harness",
      "",
      "FilesystemMiddleware exposes ls and read_file tools.",
      "SummarizationMiddleware compacts history.",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(root, "topics", "deepagents-backends.md"),
    [
      "# Deep Agents backends",
      "",
      "FilesystemBackend stores files under root_dir.",
      "StateBackend is ephemeral.",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(root, "quickstart.md"),
    "# Quickstart\n\nStart with harness architecture.\n",
    "utf8",
  );
  return root;
}

describe("tokenizeQuery", () => {
  test("splits on punctuation and lowercases", () => {
    expect(tokenizeQuery("Filesystem Backends!")).toEqual([
      "filesystem",
      "backends",
    ]);
  });
});

describe("searchWiki", () => {
  test("returns ranked hits with path line and snippet", async () => {
    const root = await createFixtureWiki();
    const hits = await searchWiki({
      rootDir: root,
      query: "FilesystemMiddleware",
      virtualRoot: "/",
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.path).toBe("topics/deepagents-harness.md");
    expect(hits[0]?.virtualPath).toBe("/topics/deepagents-harness.md");
    expect(hits[0]?.snippet.toLowerCase()).toContain("filesystemmiddleware");
    expect(hits[0]?.line).toBeGreaterThan(0);
  });

  test("multi-term queries prefer lines covering more terms", async () => {
    const root = await createFixtureWiki();
    const hits = await searchWiki({
      rootDir: root,
      query: "filesystem backends",
      virtualRoot: "/",
      maxResults: 10,
    });

    expect(hits.some((hit) => hit.path.includes("backends"))).toBe(true);
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  test("respects maxResults", async () => {
    const root = await createFixtureWiki();
    const hits = await searchWiki({
      rootDir: root,
      query: "Deep",
      maxResults: 1,
    });
    expect(hits).toHaveLength(1);
  });

  test("skips symlink files", async () => {
    const root = await createFixtureWiki();
    const target = path.join(root, "topics", "deepagents-harness.md");
    const linkPath = path.join(root, "topics", "linked.md");
    await symlink(target, linkPath);

    const hits = await searchWiki({
      rootDir: root,
      query: "FilesystemMiddleware",
    });

    expect(hits.every((hit) => hit.path !== "topics/linked.md")).toBe(true);
  });

  test("uses /openwiki virtual root for code mode", async () => {
    const root = await createFixtureWiki();
    const hits = await searchWiki({
      rootDir: root,
      query: "Quickstart",
      virtualRoot: "/openwiki/",
    });

    expect(hits[0]?.virtualPath).toBe("/openwiki/quickstart.md");
  });

  test("returns empty for blank query", async () => {
    const root = await createFixtureWiki();
    expect(await searchWiki({ rootDir: root, query: "   " })).toEqual([]);
  });
});

describe("resolveWikiRoot", () => {
  test("personal mode uses ~/.openwiki/wiki", () => {
    const root = resolveWikiRoot("personal", "/tmp/repo");
    expect(root.endsWith(`${path.sep}.openwiki${path.sep}wiki`)).toBe(true);
  });

  test("code mode uses ./openwiki under cwd", () => {
    expect(resolveWikiRoot("code", "/tmp/repo")).toBe(
      path.join("/tmp/repo", "openwiki"),
    );
  });

  test("virtual roots match mode", () => {
    expect(virtualRootForRunMode("personal")).toBe("/");
    expect(virtualRootForRunMode("code")).toBe("/openwiki/");
  });
});

describe("parseCommand — search", () => {
  test("personal search parses query and mode", () => {
    expect(parseCommand(["personal", "search", "middleware"])).toMatchObject({
      kind: "search",
      mode: "personal",
      query: "middleware",
      limit: null,
    });
  });

  test("search with --mode and --limit", () => {
    expect(
      parseCommand([
        "search",
        "--mode",
        "code",
        "--limit",
        "5",
        "filesystem",
        "backends",
      ]),
    ).toMatchObject({
      kind: "search",
      mode: "code",
      query: "filesystem backends",
      limit: 5,
    });
  });

  test("defaults bare search to personal mode", () => {
    expect(parseCommand(["search", "middleware"])).toMatchObject({
      kind: "search",
      mode: "personal",
      query: "middleware",
    });
  });

  test("errors when query missing", () => {
    expect(parseCommand(["personal", "search"])).toMatchObject({
      kind: "error",
      exitCode: 1,
    });
  });

  test("errors on invalid limit", () => {
    expect(
      parseCommand(["search", "--limit", "0", "middleware"]),
    ).toMatchObject({
      kind: "error",
      exitCode: 1,
    });
  });

  test("help mentions personal search", () => {
    const helpText = getHelpText();
    expect(helpText).toContain("openwiki personal search <query>");
    expect(helpText).toContain(
      "openwiki search [--mode personal|code] [--limit <n>] <query>",
    );
  });
});
