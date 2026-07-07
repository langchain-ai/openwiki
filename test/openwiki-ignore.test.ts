import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  isPathIgnored,
  loadOpenWikiIgnore,
  parseIgnoreContent,
} from "../src/openwiki-ignore.js";

describe("parseIgnoreContent", () => {
  test("returns empty array for empty content", () => {
    expect(parseIgnoreContent("")).toEqual([]);
    expect(parseIgnoreContent("\n\n")).toEqual([]);
  });

  test("skips comments and blank lines", () => {
    const rules = parseIgnoreContent(
      "# this is a comment\n\n*.log\n# another comment\n  \nnode_modules/",
    );

    expect(rules).toHaveLength(2);
  });

  test("compiles a basename glob", () => {
    const rules = parseIgnoreContent("*.log");

    expect(rules).toHaveLength(1);
    expect(rules[0].negate).toBe(false);
    expect(rules[0].directoryOnly).toBe(false);
  });

  test("compiles a negated pattern", () => {
    const rules = parseIgnoreContent("!important.log");

    expect(rules).toHaveLength(1);
    expect(rules[0].negate).toBe(true);
  });

  test("compiles a directory-only pattern (trailing slash)", () => {
    const rules = parseIgnoreContent("build/");

    expect(rules).toHaveLength(1);
    expect(rules[0].directoryOnly).toBe(true);
  });

  test("skips empty patterns (e.g. trailing '!')", () => {
    const rules = parseIgnoreContent("!/nope");

    expect(rules).toHaveLength(1);
  });
});

describe("isPathIgnored", () => {
  const basicRules = parseIgnoreContent("*.log\nnode_modules/\n");

  test("ignores matching file extension", () => {
    expect(isPathIgnored("server.log", basicRules)).toBe(true);
  });

  test("ignores matching file in subdirectory", () => {
    expect(isPathIgnored("logs/app.log", basicRules)).toBe(true);
  });

  test("does not ignore a non-matching file", () => {
    expect(isPathIgnored("server.txt", basicRules)).toBe(false);
    expect(isPathIgnored("readme.md", basicRules)).toBe(false);
  });

  test("ignores a matching directory", () => {
    expect(isPathIgnored("node_modules", basicRules)).toBe(true);
  });

  test("ignores a file inside a directory-only pattern", () => {
    // node_modules/ is directory-only — files inside it are also ignored
    expect(isPathIgnored("node_modules/something.js", basicRules)).toBe(true);
  });

  test("negation re-includes an otherwise ignored path", () => {
    const rules = parseIgnoreContent("*.log\n!important.log\n");

    expect(isPathIgnored("debug.log", rules)).toBe(true);
    expect(isPathIgnored("important.log", rules)).toBe(false);
  });

  test("handles ** glob patterns", () => {
    const rules = parseIgnoreContent("vendor/**/cache/\n");

    expect(isPathIgnored("vendor/cache", rules)).toBe(true);
    expect(isPathIgnored("vendor/foo/cache", rules)).toBe(true);
    expect(isPathIgnored("vendor/foo/bar/cache", rules)).toBe(true);
    // Files inside the directory-only pattern are also ignored via ancestor matching
    expect(isPathIgnored("vendor/cache/file.txt", rules)).toBe(true);
  });

  test("handles ? single-character wildcard", () => {
    const rules = parseIgnoreContent("?.txt\n");

    expect(isPathIgnored("a.txt", rules)).toBe(true);
    expect(isPathIgnored("ab.txt", rules)).toBe(false);
  });

  test("root-anchored pattern with leading slash", () => {
    const rules = parseIgnoreContent("/build/\n");

    expect(isPathIgnored("build", rules)).toBe(true);
    expect(isPathIgnored("src/build", rules)).toBe(false);
  });

  test("directory-only pattern ignores files inside the directory", () => {
    const rules = parseIgnoreContent("build/\n");

    // The directory entry itself is ignored
    expect(isPathIgnored("build", rules)).toBe(true);
    // Files inside the ignored directory are also ignored
    expect(isPathIgnored("build/output.js", rules)).toBe(true);
    expect(isPathIgnored("build/sub/detail.txt", rules)).toBe(true);
    // Files outside are not
    expect(isPathIgnored("src/app.ts", rules)).toBe(false);
  });

  test("normalizes Windows backslashes", () => {
    const rules = parseIgnoreContent("*.exe\n");

    expect(isPathIgnored("dist\\app.exe", rules)).toBe(true);
  });
});

describe("loadOpenWikiIgnore", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "openwiki-ignore-"));
  });

  afterEach(async () => {
    // No cleanup needed — tmpdir is ephemeral
  });

  test("returns default patterns when file does not exist", async () => {
    const rules = await loadOpenWikiIgnore(tmpDir);

    // Default rules: __pycache__/ and *.pyc
    expect(rules.length).toBeGreaterThanOrEqual(2);
    expect(isPathIgnored("__pycache__", rules)).toBe(true);
    expect(isPathIgnored("__pycache__/app.pyc", rules)).toBe(true);
    expect(isPathIgnored("build/output.pyc", rules)).toBe(true);
    expect(isPathIgnored("src/app.ts", rules)).toBe(false);
  });

  test("parses file content when it exists, merged with defaults", async () => {
    await writeFile(
      path.join(tmpDir, ".openwikiignore"),
      "*.log\nnode_modules/\ndist/\n",
      "utf8",
    );
    const rules = await loadOpenWikiIgnore(tmpDir);

    // 2 defaults + 3 user rules
    expect(rules.length).toBeGreaterThanOrEqual(5);
    expect(isPathIgnored("server.log", rules)).toBe(true);
    expect(isPathIgnored("node_modules", rules)).toBe(true);
    expect(isPathIgnored("dist", rules)).toBe(true);
    expect(isPathIgnored("__pycache__", rules)).toBe(true);
    expect(isPathIgnored("build/output.pyc", rules)).toBe(true);
    expect(isPathIgnored("src/app.ts", rules)).toBe(false);
  });

  test("returns default patterns when parent directory is missing", async () => {
    const rules = await loadOpenWikiIgnore(
      path.join(tmpDir, "nonexistent-dir"),
    );

    expect(rules.length).toBeGreaterThanOrEqual(2);
    expect(isPathIgnored("__pycache__", rules)).toBe(true);
  });
});
