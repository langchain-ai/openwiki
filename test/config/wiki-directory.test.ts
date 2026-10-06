import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  normalizeRepositoryWikiDirectory,
  repositoryWikiRoot,
  resolveRepositoryWikiDirectory,
  toRepositoryWikiPath,
  toVirtualWikiPath,
} from "../../src/config/wiki-directory.ts";

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "openwiki-directory-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("repository wiki directory", () => {
  test("defaults new repositories to wiki", async () => {
    const root = await createRoot();
    expect(resolveRepositoryWikiDirectory(root, {})).toBe("wiki");
  });

  test("keeps an existing legacy openwiki directory", async () => {
    const root = await createRoot();
    await mkdir(path.join(root, "openwiki"));
    expect(resolveRepositoryWikiDirectory(root, {})).toBe("openwiki");
  });

  test("prefers wiki when both conventional paths exist", async () => {
    const root = await createRoot();
    await mkdir(path.join(root, "openwiki"));
    await mkdir(path.join(root, "wiki"));
    expect(resolveRepositoryWikiDirectory(root, {})).toBe("wiki");
  });

  test("does not hide an unsafe default-path collision", async () => {
    const root = await createRoot();
    await mkdir(path.join(root, "openwiki"));
    await symlink(path.join(root, "openwiki"), path.join(root, "wiki"));
    expect(resolveRepositoryWikiDirectory(root, {})).toBe("wiki");
  });

  test("normalizes a configured nested directory", async () => {
    const root = await createRoot();
    expect(
      resolveRepositoryWikiDirectory(root, {
        OPENWIKI_WIKI_DIR: " docs/generated ",
      }),
    ).toBe("docs/generated");
    expect(normalizeRepositoryWikiDirectory("docs\\generated")).toBe(
      "docs/generated",
    );
  });

  test("reads a repository-local custom directory", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, ".openwiki.json"),
      `${JSON.stringify({ wikiDirectory: "docs/generated" })}\n`,
      "utf8",
    );
    expect(resolveRepositoryWikiDirectory(root, {})).toBe("docs/generated");
  });

  test("the environment override wins over repository configuration", async () => {
    const root = await createRoot();
    await writeFile(path.join(root, ".openwiki.json"), "{not json\n", "utf8");
    expect(
      resolveRepositoryWikiDirectory(root, {
        OPENWIKI_WIKI_DIR: "override/wiki",
      }),
    ).toBe("override/wiki");
  });

  test.each([
    ["malformed JSON", "{not json\n"],
    ["unknown fields", '{"wikiDirectory":"wiki","extra":true}\n'],
    ["non-string directory", '{"wikiDirectory":42}\n'],
  ])("rejects repository config with %s", async (_label, content) => {
    const root = await createRoot();
    await writeFile(path.join(root, ".openwiki.json"), content, "utf8");
    expect(() => resolveRepositoryWikiDirectory(root, {})).toThrow(
      /.openwiki.json/u,
    );
  });

  test("rejects a symlinked repository config", async () => {
    const root = await createRoot();
    const target = path.join(root, "config-target.json");
    await writeFile(target, '{"wikiDirectory":"wiki"}\n', "utf8");
    await symlink(target, path.join(root, ".openwiki.json"));
    expect(() => resolveRepositoryWikiDirectory(root, {})).toThrow(
      /symbolic link/u,
    );
  });

  test("rejects an oversized repository config", async () => {
    const root = await createRoot();
    await writeFile(path.join(root, ".openwiki.json"), "x".repeat(16_385));
    expect(() => resolveRepositoryWikiDirectory(root, {})).toThrow(
      /must not exceed/u,
    );
  });

  test.each([
    "",
    "   ",
    "/tmp/wiki",
    "C:\\wiki",
    ".",
    "..",
    "../wiki",
    "docs/../wiki",
    "docs//wiki",
    "docs/wiki name",
  ])("rejects unsafe configuration %j", (configured) => {
    expect(() => normalizeRepositoryWikiDirectory(configured)).toThrow(
      /OPENWIKI_WIKI_DIR/u,
    );
  });

  test("maps between physical and stable virtual paths", async () => {
    const root = await createRoot();
    expect(repositoryWikiRoot(root, "docs/wiki")).toBe(
      path.join(root, "docs/wiki"),
    );
    expect(toRepositoryWikiPath("/openwiki/guides/setup.md", "wiki")).toBe(
      "wiki/guides/setup.md",
    );
    expect(toVirtualWikiPath("wiki/guides/setup.md", "wiki")).toBe(
      "/openwiki/guides/setup.md",
    );
  });

  test("configured existing files are selected for fail-closed callers", async () => {
    const root = await createRoot();
    await writeFile(path.join(root, "custom"), "not a directory\n", "utf8");
    expect(
      resolveRepositoryWikiDirectory(root, { OPENWIKI_WIKI_DIR: "custom" }),
    ).toBe("custom");
  });
});
