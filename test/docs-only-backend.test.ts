import { mkdtemp, readFile } from "node:fs/promises";
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
