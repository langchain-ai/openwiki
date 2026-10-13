import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { clusterByBestField, loadRawRecords } from "../../src/wiki/theme-extraction.ts";

// `loadRawRecords` only recognized `.jsonl` raw pulls (ticket-shaped sources
// like Pylon/Linear), so a documentation-style connector writing individual
// .md/.mdx files silently produced zero records. The fix is a file-based
// fallback that only engages when the JSONL loader finds nothing, using each
// file's immediate parent folder as the taxonomy signal.

const LONG_ENOUGH_BODY = "word ".repeat(45);

async function writeMd(dir: string, relPath: string, opts: { title?: string; url?: string; body?: string } = {}) {
  const full = path.join(dir, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  const front = ["---", opts.title ? `title: ${opts.title}` : null, opts.url ? `url: ${opts.url}` : null, "---"]
    .filter(Boolean)
    .join("\n");
  await writeFile(full, `${front}\n\n${opts.body ?? LONG_ENOUGH_BODY}\n`, "utf8");
}

describe("loadRawRecords file-based fallback", () => {
  let rawDir: string;

  afterEach(async () => {
    if (rawDir) await rm(rawDir, { recursive: true, force: true });
  });

  test("a .jsonl pull is unaffected — the fallback never engages when JSONL records exist", async () => {
    rawDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-raw-"));
    await writeFile(path.join(rawDir, "issues.jsonl"), `${JSON.stringify({ id: "1", category: "bug" })}\n`, "utf8");
    // Also drop an .md file that would otherwise be picked up by the fallback.
    await writeMd(rawDir, "docs/should-be-ignored.md", { title: "Ignored" });

    const records = await loadRawRecords(rawDir);
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe("1");
  });

  test("a folder of markdown files clusters by immediate parent folder", async () => {
    rawDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-raw-"));
    for (let i = 0; i < 4; i++) {
      await writeMd(rawDir, `src/langsmith/page-${i}.mdx`, { title: `LangSmith Page ${i}` });
    }
    for (let i = 0; i < 4; i++) {
      await writeMd(rawDir, `src/langgraph/page-${i}.mdx`, { title: `LangGraph Page ${i}` });
    }

    const records = await loadRawRecords(rawDir);
    expect(records).toHaveLength(8);
    expect(new Set(records.map((r) => r.categoricalFields.get("path")))).toEqual(
      new Set(["langsmith", "langgraph"]),
    );

    const themes = clusterByBestField(records, { minRecords: 3 });
    expect(themes.map((t) => t.category).sort()).toEqual(["langgraph", "langsmith"]);
    expect(themes.every((t) => t.fieldName === "path")).toBe(true);
  });

  test("a flat directory (no real parent-folder signal) produces no themes, not a forced single bucket", async () => {
    rawDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-raw-"));
    for (let i = 0; i < 5; i++) {
      await writeMd(rawDir, `articles/article-${i}.md`, { title: `Article ${i}` });
    }

    const records = await loadRawRecords(rawDir);
    expect(records).toHaveLength(5);
    // Every file shares the same immediate parent ("articles"), so this is a
    // single dominant bucket, not "more than one real group" — correctly
    // rejected rather than forced into a meaningless one-category cluster.
    const themes = clusterByBestField(records, { minRecords: 3 });
    expect(themes).toHaveLength(0);
  });

  test("near-empty stub files are excluded from clustering", async () => {
    rawDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-raw-"));
    await writeMd(rawDir, "src/langsmith/real.mdx", { title: "Real page" });
    await writeMd(rawDir, "src/langsmith/stub.mdx", { title: "Stub", body: "too short" });

    const records = await loadRawRecords(rawDir);
    expect(records.map((r) => r.title)).toEqual(["Real page"]);
  });

  test("non-content directories (snippets, images, openwiki's own docs) are excluded", async () => {
    rawDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-raw-"));
    await writeMd(rawDir, "src/langsmith/real.mdx", { title: "Real" });
    await writeMd(rawDir, "src/snippets/fragment.mdx", { title: "Fragment" });
    await writeMd(rawDir, "src/images/README.mdx", { title: "Image readme" });
    await writeMd(rawDir, "src/openwiki/cli-reference.mdx", { title: "OpenWiki CLI" });

    const records = await loadRawRecords(rawDir);
    expect(records.map((r) => r.title)).toEqual(["Real"]);
  });
});
