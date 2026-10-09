import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_REPOSITORY_WIKI_DIRECTORY,
  normalizeRepositoryWikiDirectory,
  RepositoryWikiPathError,
  RepositoryWikiPaths,
  resolveRepositoryWikiRoot,
} from "../../src/repository-wiki/paths.ts";

describe("repository wiki directory paths", () => {
  test("keeps the existing default directory", () => {
    expect(DEFAULT_REPOSITORY_WIKI_DIRECTORY).toBe("openwiki");
  });

  test.each([
    ["docs", "docs"],
    ["docs/wiki", "docs/wiki"],
    ["docs\\wiki", "docs/wiki"],
    ["documentation v2", "documentation v2"],
    ["文档", "文档"],
    ["team's-docs", "team's-docs"],
  ])("normalizes portable repository-relative input %j", (input, expected) => {
    expect(normalizeRepositoryWikiDirectory(input)).toBe(expected);
  });

  test.each([
    "",
    " docs",
    "docs ",
    "docs/ wiki",
    "docs/wiki ",
    "/docs",
    "C:\\docs",
    "C:docs",
    "docs/",
    "docs//wiki",
    ".",
    "..",
    "docs/./wiki",
    "docs/../wiki",
    ".git",
    "docs/.GIT/wiki",
    "docs\0wiki",
    "docs\nwiki",
  ])("rejects unsafe directory input %j", (input) => {
    expect(() => normalizeRepositoryWikiDirectory(input)).toThrow(
      RepositoryWikiPathError,
    );
  });

  test("resolves a contained absolute root", () => {
    const repositoryRoot = path.join(os.tmpdir(), "repository-wiki-paths");
    expect(resolveRepositoryWikiRoot(repositoryRoot, "docs/wiki")).toBe(
      path.join(repositoryRoot, "docs", "wiki"),
    );
  });

  test("requires an absolute repository root", () => {
    expect(() => resolveRepositoryWikiRoot("relative", "docs")).toThrow(
      "absolute repository root",
    );
  });
});

describe("RepositoryWikiPaths", () => {
  const paths = new RepositoryWikiPaths("docs/wiki");

  test("exposes canonical reserved paths", () => {
    expect(paths.directory).toBe("docs/wiki");
    expect(paths.canonicalRoot).toBe("/docs/wiki");
    expect(paths.quickstartPage).toBe("/docs/wiki/quickstart.md");
    expect(paths.instructionsPage).toBe("/docs/wiki/INSTRUCTIONS.md");
  });

  test.each([
    ["overview.md", "/docs/wiki/overview.md"],
    ["architecture/overview.md", "/docs/wiki/architecture/overview.md"],
    ["docs/wiki/overview.md", "/docs/wiki/overview.md"],
    ["/docs/wiki/overview.md", "/docs/wiki/overview.md"],
    ["architecture\\overview.md", "/docs/wiki/architecture/overview.md"],
  ])("normalizes actual and wiki-relative page %j", (input, expected) => {
    expect(paths.normalizePage(input)).toBe(expected);
  });

  test("converts canonical paths for repository and sidecar operations", () => {
    expect(paths.toRepositoryPage("/docs/wiki/guides/setup.md")).toBe(
      "docs/wiki/guides/setup.md",
    );
    expect(paths.toWikiRelativePage("/docs/wiki/guides/setup.md")).toBe(
      "guides/setup.md",
    );
  });

  test("distinguishes the root from prefix lookalikes", () => {
    expect(paths.contains("/docs/wiki")).toBe(true);
    expect(paths.contains("/docs/wiki/page.md")).toBe(true);
    expect(paths.contains("docs/wiki/page.md")).toBe(true);
    expect(paths.contains("/docs/wiki-old/page.md")).toBe(false);
    expect(paths.contains("/docs/wik/page.md")).toBe(false);
    expect(paths.contains(" /docs/wiki/page.md")).toBe(false);
  });

  test.each([
    "",
    "page.txt",
    "../page.md",
    "section/../page.md",
    "section/./page.md",
    "section//page.md",
    " page.md",
    "page.md ",
    "page\n.md",
    "/outside/page.md",
    "/docs/wiki-old/page.md",
  ])("rejects malformed page input %j", (input) => {
    expect(() => paths.normalizePage(input)).toThrow(RepositoryWikiPathError);
  });
});
