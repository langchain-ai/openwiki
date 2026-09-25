import type {
  BackendProtocolV2,
  EditResult,
  LsResult,
  ReadRawResult,
} from "deepagents";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { OpenWikiLocalShellBackend } from "../../src/agent/docs-only-backend.ts";
import { validateWikiMermaid } from "../../src/mermaid/wiki.ts";

/**
 * Builds a minimal stub backend so the read/write error branches, which the
 * real disk-backed backend does not surface deterministically, can be driven.
 */
function stubBackend(handlers: {
  ls?: (p: string) => LsResult;
  readRaw?: (p: string) => ReadRawResult;
  edit?: (p: string) => EditResult;
}): BackendProtocolV2 {
  return {
    ls: vi.fn(handlers.ls ?? (() => ({ files: [] }))),
    readRaw: vi.fn(handlers.readRaw ?? (() => ({ data: undefined }))),
    edit: vi.fn(handlers.edit ?? (() => ({}))),
  } as unknown as BackendProtocolV2;
}

const BROKEN_BODY = ["flowchart TD", "  A[Start] --> end[The End]"].join("\n");
const BROKEN_DOC = ["```mermaid", BROKEN_BODY, "```"].join("\n");

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

describe("validateWikiMermaid backend error handling", () => {
  test("treats a subdirectory that cannot be listed as empty", async () => {
    // A directory whose listing fails is skipped rather than aborting the scan,
    // matching the index middleware's tolerance.
    const backend = stubBackend({
      ls: (p) =>
        p === "/openwiki"
          ? { files: [{ path: "/openwiki/sub/", is_dir: true }] }
          : { error: "listing denied" },
    });

    const report = await validateWikiMermaid(backend, "repository");
    expect(report.filesScanned).toBe(0);
  });

  test("joins array-shaped file content before scanning", async () => {
    // Some backends return content as a line array; it must be joined to text,
    // and a clean file leaves no diff.
    const backend = stubBackend({
      ls: () => ({ files: [{ path: "/openwiki/a.md", is_dir: false }] }),
      readRaw: () => ({
        data: {
          content: ["# Title", "", "Prose only, no fences."],
          mimeType: "text/markdown",
          created_at: "2026-07-13T00:00:00.000Z",
          modified_at: "2026-07-13T00:00:00.000Z",
        },
      }),
    });

    const report = await validateWikiMermaid(backend, "repository");
    expect(report.filesScanned).toBe(1);
    expect(report.fencesDegraded).toBe(0);
  });

  test("throws an actionable error when a file cannot be read", async () => {
    const backend = stubBackend({
      ls: () => ({ files: [{ path: "/openwiki/a.md", is_dir: false }] }),
      readRaw: () => ({ error: "read denied" }),
    });

    await expect(validateWikiMermaid(backend, "repository")).rejects.toThrow(
      /Unable to read \/openwiki\/a\.md/u,
    );
  });

  test("rejects a non-text file rather than mangling it", async () => {
    // Binary content has no text form to scan, so the scan fails loudly instead
    // of silently corrupting the file.
    const backend = stubBackend({
      ls: () => ({ files: [{ path: "/openwiki/a.md", is_dir: false }] }),
      readRaw: () => ({
        data: {
          content: new Uint8Array([1, 2, 3]),
          mimeType: "application/octet-stream",
          created_at: "2026-07-13T00:00:00.000Z",
          modified_at: "2026-07-13T00:00:00.000Z",
        },
      }),
    });

    await expect(validateWikiMermaid(backend, "repository")).rejects.toThrow(
      /is not a text file/u,
    );
  });

  test("surfaces a rewrite failure for a degraded file", async () => {
    // When the degraded rewrite cannot be persisted the run fails rather than
    // leaving a broken diagram unrepaired and unreported.
    const backend = stubBackend({
      ls: () => ({ files: [{ path: "/openwiki/a.md", is_dir: false }] }),
      readRaw: () => ({
        data: {
          content: `# Page\n\n${BROKEN_DOC}\n`,
          mimeType: "text/markdown",
          created_at: "2026-07-13T00:00:00.000Z",
          modified_at: "2026-07-13T00:00:00.000Z",
        },
      }),
      edit: () => ({ error: "write denied" }),
    });

    await expect(validateWikiMermaid(backend, "repository")).rejects.toThrow(
      /Unable to rewrite \/openwiki\/a\.md/u,
    );
  });
});
