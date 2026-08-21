import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  isClaimsStatePath,
  isOpenWikiDocsPath,
  MUTATION_PATH_METADATA_KEY,
  OpenWikiLocalShellBackend,
} from "../../src/agent/docs-only-backend.ts";

describe("OpenWikiLocalShellBackend", () => {
  test("recognizes canonical Claims state paths without reserving lookalikes", () => {
    expect(isClaimsStatePath("/openwiki/.claims/page.json")).toBe(true);
    expect(isClaimsStatePath("/OPENWIKI/.CLAIMS/page.json")).toBe(true);
    expect(isClaimsStatePath("\\OpenWiki\\.Claims\\page.json")).toBe(true);
    expect(isClaimsStatePath("openwiki/section/../.claims/page.json")).toBe(
      true,
    );
    expect(isClaimsStatePath("/openwiki/.claims-other/page.json")).toBe(false);
    expect(isClaimsStatePath("/.claims/page.json")).toBe(false);
  });

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

  test("rejects `..` traversal that escapes the openwiki dir", () => {
    expect(isOpenWikiDocsPath("/openwiki/../AGENTS.md")).toBe(false);
    expect(isOpenWikiDocsPath("openwiki/../AGENTS.md")).toBe(false);
    expect(isOpenWikiDocsPath("/openwiki/../../etc/passwd")).toBe(false);
    expect(isOpenWikiDocsPath("\\openwiki\\..\\AGENTS.md")).toBe(false);
    // A `..` that resolves back inside openwiki/ is still allowed.
    expect(isOpenWikiDocsPath("/openwiki/sub/../architecture.md")).toBe(true);
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

    const traversalWrite = await backend.write("/openwiki/../AGENTS.md", "bad");
    expect(traversalWrite.error).toContain(
      "Refused path: /openwiki/../AGENTS.md",
    );
    expect(traversalWrite.metadata).toBeUndefined();
    await expect(
      readFile(path.join(rootDir, "AGENTS.md"), "utf8"),
    ).rejects.toThrow();
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

  test("handles file-backed Git worktree metadata without crashing glob", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-backend-"));
    await writeFile(path.join(rootDir, ".git"), "gitdir: /tmp/example\n");
    await mkdir(path.join(rootDir, "src"));
    await writeFile(path.join(rootDir, "src", "index.ts"), "export {};\n");
    const backend = new OpenWikiLocalShellBackend({
      docsOnly: true,
      rootDir,
      virtualMode: true,
    });

    const unboundedGlob = await backend.glob("**/*");
    expect(unboundedGlob.error).toContain(
      "Unbounded root globbing is disabled",
    );
    const gitGlob = await backend.glob(".git/**/*");
    expect(gitGlob.error).toContain("Git metadata");
    await expect(backend.glob("**/*.ts", "/src")).resolves.toEqual({
      files: [expect.objectContaining({ path: "/index.ts", is_dir: false })],
    });
  });

  test("hides repository Claims state while preserving ordinary shell inspection", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-backend-"));
    const claimsDir = path.join(rootDir, "openwiki/.claims");
    await mkdir(claimsDir, { recursive: true });
    await writeFile(
      path.join(claimsDir, "page.json"),
      '{"private":"claims-marker"}\n',
      "utf8",
    );
    await writeFile(path.join(rootDir, "openwiki/page.md"), "# Page\n", "utf8");
    const backend = new OpenWikiLocalShellBackend({
      docsOnly: true,
      outputMode: "repository",
      rootDir,
      virtualMode: true,
    });

    const read = await backend.read("/openwiki/.claims/page.json");
    expect(read.error).toContain("Claims state");
    const mixedCaseRead = await backend.read("/openwiki/.CLAIMS/page.json");
    expect(mixedCaseRead.error).toContain("Claims state");
    const readRaw = await backend.readRaw("/openwiki/.claims/page.json");
    expect(readRaw.error).toContain("Claims state");
    const write = await backend.write("/openwiki/.claims/new.json", "bad");
    expect(write.error).toContain("Claims state");
    const edit = await backend.edit(
      "/openwiki/.claims/page.json",
      "claims-marker",
      "changed",
    );
    expect(edit.error).toContain("Claims state");
    const deletion = await backend.delete("/openwiki/.claims/page.json");
    expect(deletion.error).toContain("Claims state");
    await expect(
      backend.uploadFiles([
        ["/openwiki/.claims/upload.json", new Uint8Array([1])],
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ error: "permission_denied" }),
    ]);
    await expect(
      backend.downloadFiles(["/openwiki/.claims/page.json"]),
    ).resolves.toEqual([
      expect.objectContaining({ error: "permission_denied", content: null }),
    ]);

    const listing = await backend.ls("/openwiki");
    expect(listing.files?.map((file) => file.path)).toEqual([
      "/openwiki/page.md",
    ]);
    const glob = await backend.glob("**/*", "/openwiki");
    expect(glob.files?.map((file) => file.path)).toEqual(["/page.md"]);
    await expect(backend.grep("claims-marker", "/openwiki")).resolves.toEqual({
      matches: [],
    });

    const inspection = await backend.execute("pwd");
    expect(inspection.exitCode).toBe(0);
    expect(inspection.output).toContain(rootDir);
    const claimsInspection = await backend.execute(
      "cat openwiki/.claims/page.json",
    );
    expect(claimsInspection.exitCode).toBe(1);
    expect(claimsInspection.output).toContain("Claims state");
    const mixedCaseInspection = await backend.execute(
      "cat OPENWIKI/.CLAIMS/page.json",
    );
    expect(mixedCaseInspection.exitCode).toBe(1);
    expect(mixedCaseInspection.output).toContain("Claims state");
  });

  test("does not reserve personal-brain .claims paths", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-backend-"));
    const backend = new OpenWikiLocalShellBackend({
      docsOnly: true,
      outputMode: "local-wiki",
      rootDir,
      virtualMode: true,
    });

    await expect(
      backend.write("/.claims/note.md", "personal"),
    ).resolves.toEqual(expect.objectContaining({ path: "/.claims/note.md" }));
  });

  test("records successful delete mutations for authoring middleware", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-backend-"));
    await mkdir(path.join(rootDir, "openwiki"));
    await writeFile(path.join(rootDir, "openwiki/page.md"), "# Page\n", "utf8");
    const backend = new OpenWikiLocalShellBackend({
      docsOnly: true,
      rootDir,
      virtualMode: true,
    });

    const result = await backend.delete("/openwiki/page.md");

    expect(result).toEqual(
      expect.objectContaining({ path: "/openwiki/page.md" }),
    );
    expect(
      (result as { metadata?: Record<string, unknown> }).metadata?.[
        MUTATION_PATH_METADATA_KEY
      ],
    ).toBe("/openwiki/page.md");
  });
});
