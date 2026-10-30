import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { countThemeEvidence } from "../../src/wiki/graph-maintenance.ts";

// EVIDENCE_REF_TEST/EVIDENCE_REF_MATCH_ALL must recognize file-path-based
// evidence ids (e.g. "#docs-repo/src/langsmith/access-current-span.mdx"),
// not just Pylon/Linear-style citations (#31278, PROJ-123) — otherwise a
// file-path-based theme's evidenceCount silently computes to 0, permanently
// excluding it from graduation.

describe("countThemeEvidence evidence-ref parsing", () => {
  let wikiDir: string;

  afterEach(async () => {
    if (wikiDir) await rm(wikiDir, { recursive: true, force: true });
  });

  async function setupWiki(themesBody: string): Promise<void> {
    wikiDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-evidence-refs-"));
    await mkdir(path.join(wikiDir, "topics"), { recursive: true });
    await writeFile(
      path.join(wikiDir, "themes.md"),
      `<!-- deterministic:docs:begin -->\n| Theme | Description | Confidence | Evidence | Status |\n|---|---|---|---|---|\n${themesBody}\n<!-- deterministic:docs:end -->\n`,
      "utf8",
    );
  }

  test("counts file-path evidence ids, not just numeric/ticket ones", async () => {
    await setupWiki(
      "| **Tracing** | 3 records | source-backed | #docs-repo/src/langsmith/trace.mdx, #docs-repo/src/langsmith/conditional-tracing.mdx, #docs-repo/src/langsmith/view-traces.mdx | active |",
    );
    const rows = await countThemeEvidence(wikiDir);
    expect(rows).toHaveLength(1);
    expect(rows[0].evidenceCount).toBe(3);
  });

  test("still counts Pylon-style numeric and Linear-style ticket ids (no regression)", async () => {
    await setupWiki(
      "| **Billing** | 2 records | source-backed | #31278, #31113, PROJ-42 | active |",
    );
    const rows = await countThemeEvidence(wikiDir);
    expect(rows[0].evidenceCount).toBe(3);
  });

  test("a mix of file-path and numeric ids in one row counts both kinds", async () => {
    await setupWiki(
      "| **Mixed** | 2 records | source-backed | #docs-repo/src/oss/memory.mdx, #31278 | active |",
    );
    const rows = await countThemeEvidence(wikiDir);
    expect(rows[0].evidenceCount).toBe(2);
  });

  test("a bare short id with no path separator is still not miscounted as evidence", async () => {
    await setupWiki("| **Empty** | 0 records | source-backed | #tag | active |");
    const rows = await countThemeEvidence(wikiDir);
    expect(rows[0].evidenceCount).toBe(0);
  });
});
