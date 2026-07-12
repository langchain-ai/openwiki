import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  isBinaryReadContent,
  isOpenWikiDocsPath,
  OpenWikiLocalShellBackend,
} from "../src/agent/docs-only-backend.ts";

describe("OpenWikiLocalShellBackend", () => {
  test("recognizes only openwiki virtual paths as docs paths", () => {
    expect(isOpenWikiDocsPath("/openwiki/architecture.md")).toBe(true);
    expect(isOpenWikiDocsPath("openwiki/architecture.md")).toBe(true);
    expect(isOpenWikiDocsPath("\\openwiki\\operations.md")).toBe(true);
    expect(isOpenWikiDocsPath("/penwiki/architecture.md")).toBe(false);
    expect(isOpenWikiDocsPath("/AGENTS.md")).toBe(false);
    expect(isOpenWikiDocsPath("/home/runner/openwiki/architecture.md")).toBe(
      false,
    );
  });

  test("refuses init/update writes outside openwiki", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-backend-"));
    const backend = new OpenWikiLocalShellBackend({
      docsOnly: true,
      rootDir,
      virtualMode: true,
    });

    await expect(
      backend.write("/openwiki/architecture.md", "ok"),
    ).resolves.toEqual(
      expect.objectContaining({ path: "/openwiki/architecture.md" }),
    );
    await expect(
      readFile(path.join(rootDir, "openwiki/architecture.md"), "utf8"),
    ).resolves.toBe("ok");

    const penwikiWrite = await backend.write("/penwiki/architecture.md", "bad");
    expect(penwikiWrite.error).toContain(
      "Refused path: /penwiki/architecture.md",
    );

    const agentsEdit = await backend.edit("/AGENTS.md", "old", "new");
    expect(agentsEdit.error).toContain("Refused path: /AGENTS.md");
  });

  test("allows local-wiki init/update writes at the wiki virtual root", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-backend-"));
    const backend = new OpenWikiLocalShellBackend({
      docsOnly: true,
      outputMode: "local-wiki",
      rootDir,
      virtualMode: true,
    });

    await expect(backend.write("/quickstart.md", "ok")).resolves.toEqual(
      expect.objectContaining({ path: "/quickstart.md" }),
    );
    await expect(
      readFile(path.join(rootDir, "quickstart.md"), "utf8"),
    ).resolves.toBe("ok");
  });

  test("keeps chat-mode style backends unrestricted when docsOnly is false", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-backend-"));
    const backend = new OpenWikiLocalShellBackend({
      docsOnly: false,
      rootDir,
      virtualMode: true,
    });

    await expect(backend.write("/notes.md", "ok")).resolves.toEqual(
      expect.objectContaining({ path: "/notes.md" }),
    );
    await expect(
      readFile(path.join(rootDir, "notes.md"), "utf8"),
    ).resolves.toBe("ok");
  });

  test("passes text file reads through unchanged", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-backend-"));
    const backend = new OpenWikiLocalShellBackend({
      docsOnly: true,
      rootDir,
      virtualMode: true,
    });
    await writeFile(path.join(rootDir, "readme.md"), "# Title\n\nHello.\n");

    const result = await backend.read("/readme.md");
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("Hello.");
    expect(String(result.content)).not.toContain("Binary file skipped");
  });

  test("replaces binary file reads with a text placeholder", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-backend-"));
    const backend = new OpenWikiLocalShellBackend({
      docsOnly: true,
      rootDir,
      virtualMode: true,
    });
    // SQLite-style header with a NUL byte — the residual case after
    // deepagentsjs#656: no longer a crash, just token noise without this guard.
    const binary = Buffer.from([
      0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x00, 0x01, 0x02, 0x03,
    ]);
    await writeFile(path.join(rootDir, "cache.sqlite"), binary);

    const result = await backend.read("/cache.sqlite");
    expect(result.error).toBeUndefined();
    expect(result.mimeType).toBe("text/plain");
    expect(String(result.content)).toContain(
      "Binary file skipped: /cache.sqlite",
    );
  });

  test("replaces invalid-UTF-8 binary reads (0xFF firmware) with a placeholder", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-backend-"));
    const backend = new OpenWikiLocalShellBackend({
      docsOnly: true,
      rootDir,
      virtualMode: true,
    });
    // A 0xFF-filled region decodes to U+FFFD (not NUL/C0) before the sniff runs
    // — the gap Codex caught: it slipped through as text without this case.
    await writeFile(
      path.join(rootDir, "firmware.bin"),
      Buffer.alloc(16384, 0xff),
    );

    const result = await backend.read("/firmware.bin");
    expect(result.error).toBeUndefined();
    expect(result.mimeType).toBe("text/plain");
    expect(String(result.content)).toContain(
      "Binary file skipped: /firmware.bin",
    );
  });

  test("preserves read errors for missing files", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-backend-"));
    const backend = new OpenWikiLocalShellBackend({
      docsOnly: true,
      rootDir,
      virtualMode: true,
    });

    const result = await backend.read("/does-not-exist.md");
    expect(result.error).toBeDefined();
    expect(result.content).toBeUndefined();
  });
});

describe("isBinaryReadContent", () => {
  test("treats Uint8Array content as binary", () => {
    expect(isBinaryReadContent(new Uint8Array([1, 2, 3]))).toBe(true);
  });

  test("flags strings containing a NUL byte", () => {
    expect(isBinaryReadContent("PK\u0003\u0004\u0000payload")).toBe(true);
  });

  test("flags strings dense with control characters", () => {
    expect(isBinaryReadContent("\u0001\u0002\u0003\u0004\u0005abc")).toBe(true);
  });

  test("flags strings dense with UTF-8 replacement characters", () => {
    expect(isBinaryReadContent("\uFFFD".repeat(50) + "abc")).toBe(true);
  });

  test("passes normal source text", () => {
    expect(isBinaryReadContent("export function f() {\n  return 1;\n}\n")).toBe(
      false,
    );
  });

  test("treats empty content as text", () => {
    expect(isBinaryReadContent("")).toBe(false);
  });

  test("tolerates ordinary whitespace control chars", () => {
    expect(isBinaryReadContent("a\tb\r\nc\f\n")).toBe(false);
  });
});
