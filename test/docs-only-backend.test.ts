import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
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

  test("reads text files normally regardless of extension", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-backend-"));
    await writeFile(path.join(rootDir, "script.jl"), 'println("hi")\n');
    await writeFile(path.join(rootDir, "Makefile"), "all:\n\techo hi\n");
    const backend = new OpenWikiLocalShellBackend({
      docsOnly: true,
      rootDir,
      virtualMode: true,
    });

    const julia = await backend.read("/script.jl");
    expect(julia.error).toBeUndefined();
    expect(julia.content).toContain('println("hi")');

    const makefile = await backend.read("/Makefile");
    expect(makefile.error).toBeUndefined();
    expect(makefile.content).toContain("echo hi");
  });

  test("returns a readable error instead of binary content for non-image binary files", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-backend-"));
    await writeFile(path.join(rootDir, "doc.pdf"), "%PDF-1.4 fake\n");
    const backend = new OpenWikiLocalShellBackend({
      docsOnly: true,
      rootDir,
      virtualMode: true,
    });

    const result = await backend.read("/doc.pdf");
    expect(result.content).toBeUndefined();
    expect(result.error).toContain("application/pdf");
    expect(result.error).toContain("Skip this file");
  });

  test("passes image reads through unchanged", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-backend-"));
    // 1x1 transparent PNG
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(path.join(rootDir, "logo.png"), png);
    const backend = new OpenWikiLocalShellBackend({
      docsOnly: true,
      rootDir,
      virtualMode: true,
    });

    const result = await backend.read("/logo.png");
    expect(result.error).toBeUndefined();
    expect(result.mimeType).toBe("image/png");
    expect(ArrayBuffer.isView(result.content)).toBe(true);
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
});
