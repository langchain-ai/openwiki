import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveEvidenceExcerpts } from "../../src/wiki/theme-extraction.ts";

// An agent scoped to the wiki directory has no filesystem access to a
// connector's raw pull, so this reads real content up front (in the
// orchestrator, which has full filesystem access) for any evidence id
// shaped like a relative file path, regardless of which connector produced
// it.

describe("resolveEvidenceExcerpts", () => {
  let rawPullRoot: string;

  afterEach(async () => {
    if (rawPullRoot) await rm(rawPullRoot, { recursive: true, force: true });
  });

  async function setupRawPull(files: Record<string, string>): Promise<void> {
    rawPullRoot = await mkdtemp(path.join(os.tmpdir(), "openwiki-raw-pull-"));
    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = path.join(rawPullRoot, relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf8");
    }
  }

  test("reads real content for file-path-shaped evidence ids", async () => {
    await setupRawPull({ "some-source/area/quickstart.mdx": "# Quickstart\n\nRun `pip install thing` then `thing init`." });
    const excerpts = await resolveEvidenceExcerpts(rawPullRoot, ["some-source/area/quickstart.mdx"]);
    expect(excerpts).toHaveLength(1);
    expect(excerpts[0].id).toBe("some-source/area/quickstart.mdx");
    expect(excerpts[0].excerpt).toContain("pip install thing");
  });

  test("strips the leading # citation marker extractEvidenceRefs leaves on file-path ids", async () => {
    // extractEvidenceRefs (graph-maintenance.ts) returns ids like
    // "#docs-repo/src/langsmith/fleet/quickstart.mdx" — the caller passes
    // these straight through without stripping the marker itself.
    await setupRawPull({ "docs-repo/src/area/quickstart.mdx": "Real quickstart content." });
    const excerpts = await resolveEvidenceExcerpts(rawPullRoot, ["#docs-repo/src/area/quickstart.mdx"]);
    expect(excerpts).toHaveLength(1);
    expect(excerpts[0].id).toBe("docs-repo/src/area/quickstart.mdx");
    expect(excerpts[0].excerpt).toBe("Real quickstart content.");
  });

  test("silently skips non-file-path evidence ids (e.g. a bare ticket number)", async () => {
    await setupRawPull({});
    const excerpts = await resolveEvidenceExcerpts(rawPullRoot, ["31278", "PROJ-42"]);
    expect(excerpts).toEqual([]);
  });

  test("silently skips a file-path-shaped id that doesn't actually exist", async () => {
    await setupRawPull({ "real/file.mdx": "content" });
    const excerpts = await resolveEvidenceExcerpts(rawPullRoot, ["real/file.mdx", "fake/missing.mdx"]);
    expect(excerpts).toHaveLength(1);
    expect(excerpts[0].id).toBe("real/file.mdx");
  });

  test("truncates content longer than maxCharsPerFile", async () => {
    await setupRawPull({ "area/long.mdx": "x".repeat(5000) });
    const excerpts = await resolveEvidenceExcerpts(rawPullRoot, ["area/long.mdx"], { maxCharsPerFile: 100 });
    expect(excerpts[0].excerpt.length).toBeLessThan(200);
    expect(excerpts[0].excerpt).toContain("...(truncated)");
  });

  test("stops at maxFiles even when more ids are given", async () => {
    await setupRawPull({ "area/a.mdx": "a", "area/b.mdx": "b", "area/c.mdx": "c" });
    const excerpts = await resolveEvidenceExcerpts(
      rawPullRoot,
      ["area/a.mdx", "area/b.mdx", "area/c.mdx"],
      { maxFiles: 2 },
    );
    expect(excerpts).toHaveLength(2);
  });

  test("refuses to escape the raw pull root via a path-traversal id", async () => {
    await setupRawPull({});
    const outsideFile = path.join(path.dirname(rawPullRoot), "secret.txt");
    await writeFile(outsideFile, "should never be read");
    try {
      const excerpts = await resolveEvidenceExcerpts(rawPullRoot, ["../secret.txt"]);
      expect(excerpts).toEqual([]);
    } finally {
      await rm(outsideFile, { force: true });
    }
  });

  test("an empty evidence id list produces no excerpts and does no file I/O", async () => {
    await setupRawPull({ "a.mdx": "a" });
    const excerpts = await resolveEvidenceExcerpts(rawPullRoot, []);
    expect(excerpts).toEqual([]);
  });
});
