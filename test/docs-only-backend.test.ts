import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  isConversationHistoryPath,
  isOpenWikiDocsPath,
  MUTATION_PATH_METADATA_KEY,
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

  test("recognizes conversation history virtual paths", () => {
    expect(isConversationHistoryPath("/conversation_history/session_1.md")).toBe(true);
    expect(isConversationHistoryPath("conversation_history/session_1.md")).toBe(true);
    expect(isConversationHistoryPath("\\conversation_history\\session_1.md")).toBe(true);
    expect(isConversationHistoryPath("/conversation_history")).toBe(true);
    expect(isConversationHistoryPath("/not_conversation_history/session_1.md")).toBe(false);
  });

  test("refuses init/update writes outside openwiki", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-backend-"));
    const backend = new OpenWikiLocalShellBackend({
      docsOnly: true,
      rootDir,
      virtualMode: true,
    });

    const write = await backend.write("/openwiki/architecture.md", "ok");
    expect(write).toEqual(
      expect.objectContaining({ path: "/openwiki/architecture.md" }),
    );
    expect(write.metadata?.[MUTATION_PATH_METADATA_KEY]).toBe(
      "/openwiki/architecture.md",
    );
    await expect(
      readFile(path.join(rootDir, "openwiki/architecture.md"), "utf8"),
    ).resolves.toBe("ok");

    const penwikiWrite = await backend.write("/penwiki/architecture.md", "bad");
    expect(penwikiWrite.error).toContain(
      "Refused path: /penwiki/architecture.md",
    );
    expect(penwikiWrite.metadata).toBeUndefined();

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

    const write = await backend.write("/quickstart.md", "ok");
    expect(write).toEqual(expect.objectContaining({ path: "/quickstart.md" }));
    const edit = await backend.edit("/quickstart.md", "ok", "updated");
    expect(edit.metadata?.[MUTATION_PATH_METADATA_KEY]).toBe("/quickstart.md");
    await expect(
      readFile(path.join(rootDir, "quickstart.md"), "utf8"),
    ).resolves.toBe("updated");
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

  test("redirects conversation history writes and resolves them to openWikiHistoryDir", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-backend-"));
    const backend = new OpenWikiLocalShellBackend({
      docsOnly: true,
      rootDir,
      virtualMode: true,
    });

    const virtualPath = "/conversation_history/session_test.md";
    const expectedRealPath = (
      backend as unknown as { resolvePath(key: string): string }
    ).resolvePath(virtualPath);

    // Verify it resolves under openWikiHistoryDir (outside rootDir)
    expect(expectedRealPath).not.toContain(rootDir);
    expect(expectedRealPath).toContain(".openwiki");
    expect(expectedRealPath).toContain("conversation_history");

    // Verify that writing is allowed even when docsOnly is true
    const writeResult = await backend.write(virtualPath, "history content");
    expect(writeResult.error).toBeUndefined();
    expect(writeResult.path).toBe(virtualPath);

    // Clean up if the file was written
    const { rm } = await import("node:fs/promises");
    await rm(expectedRealPath, { force: true });
  });
});
