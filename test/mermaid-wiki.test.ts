import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { OpenWikiLocalShellBackend } from "../src/agent/docs-only-backend.ts";
import { validateWikiMermaid } from "../src/mermaid/wiki.ts";

const VALID = [
  "```mermaid",
  "sequenceDiagram",
  "  Alice->>Bob: Hi",
  "```",
].join("\n");

// `end` is a reserved word, so this flowchart fails to parse.
const BROKEN = [
  "```mermaid",
  "flowchart TD",
  "  A[Start] --> end[The End]",
  "```",
].join("\n");

/** Creates a docs-only backend over a fresh temp directory. */
async function setup(outputMode: "local-wiki" | "repository" = "repository") {
  const rootDir = await mkdtemp(
    path.join(os.tmpdir(), "openwiki-mermaid-wiki-"),
  );
  const backend = new OpenWikiLocalShellBackend({
    docsOnly: true,
    outputMode,
    rootDir,
    virtualMode: true,
  });
  return { backend, rootDir };
}

describe("validateWikiMermaid", () => {
  test("degrades only files with failing fences and leaves valid files untouched", async () => {
    const { backend, rootDir } = await setup();
    await backend.write("/openwiki/good.md", `# Good\n\n${VALID}\n`);
    await backend.write(
      "/openwiki/architecture/bad.md",
      `# Bad\n\n${BROKEN}\n`,
    );

    const goodBefore = await readFile(
      path.join(rootDir, "openwiki/good.md"),
      "utf8",
    );
    const edit = vi.spyOn(backend, "edit");

    const report = await validateWikiMermaid(backend, "repository");

    expect(report.filesScanned).toBe(2);
    expect(report.fencesChecked).toBe(2);
    expect(report.fencesDegraded).toBe(1);
    expect(report.repairedFiles).toEqual([
      path.posix.join("architecture", "bad.md"),
    ]);

    // The valid file is never edited and stays byte-for-byte identical.
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledWith(
      "/openwiki/architecture/bad.md",
      expect.any(String),
      expect.any(String),
    );
    await expect(
      readFile(path.join(rootDir, "openwiki/good.md"), "utf8"),
    ).resolves.toBe(goodBefore);

    // The broken file is degraded in place.
    const badAfter = await readFile(
      path.join(rootDir, "openwiki/architecture/bad.md"),
      "utf8",
    );
    expect(badAfter).toContain("```text");
    expect(badAfter).toContain("openwiki: mermaid parse failed");
  });

  test("skips reserved files, dotfiles, and dot-directories", async () => {
    const { backend, rootDir } = await setup();
    const dir = path.join(rootDir, "openwiki");
    await mkdir(path.join(dir, ".hidden"), { recursive: true });
    for (const name of [
      "index.md",
      "log.md",
      "_plan.md",
      "INSTRUCTIONS.md",
      ".secret.md",
    ]) {
      await writeFile(path.join(dir, name), `# X\n\n${BROKEN}\n`);
    }
    await writeFile(
      path.join(dir, ".hidden", "buried.md"),
      `# X\n\n${BROKEN}\n`,
    );

    const edit = vi.spyOn(backend, "edit");
    const report = await validateWikiMermaid(backend, "repository");

    expect(report.filesScanned).toBe(0);
    expect(report.fencesDegraded).toBe(0);
    expect(edit).not.toHaveBeenCalled();
  });

  test("roots at /openwiki in repository mode with root-relative repaired paths", async () => {
    const { backend } = await setup("repository");
    await backend.write("/openwiki/sub/page.md", `# P\n\n${BROKEN}\n`);

    const report = await validateWikiMermaid(backend, "repository");

    expect(report.repairedFiles).toEqual([path.posix.join("sub", "page.md")]);
  });

  test("roots at / in local-wiki mode with root-relative repaired paths", async () => {
    const { backend } = await setup("local-wiki");
    await backend.write("/page.md", `# P\n\n${BROKEN}\n`);

    const report = await validateWikiMermaid(backend, "local-wiki");

    expect(report.repairedFiles).toEqual(["page.md"]);
  });

  test("returns a zero report for a missing wiki root without throwing", async () => {
    const { backend } = await setup("repository");

    // Nothing was written, so /openwiki does not exist.
    const report = await validateWikiMermaid(backend, "repository");

    expect(report).toEqual({
      filesScanned: 0,
      fencesChecked: 0,
      fencesDegraded: 0,
      repairedFiles: [],
    });
  });
});
