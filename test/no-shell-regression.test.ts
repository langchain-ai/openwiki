import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FilesystemBackend } from "deepagents";
import { describe, expect, test } from "vitest";
import { createRunBackend, createRunPermissions } from "../src/agent/index.ts";
import { OpenWikiLocalShellBackend } from "../src/agent/docs-only-backend.ts";
import { buildOpenWikiTools } from "../src/agent/tools/index.ts";
import { createGitReadOnlyTools } from "../src/agent/tools/git-tools.ts";
import { resolveWithinRoot } from "../src/agent/tools/shared/path-validation.ts";

type Command = "chat" | "init" | "update";
type OutputMode = "local-wiki" | "repository";

describe("no-shell regression", () => {
  test.each([
    ["repository", "init"],
    ["repository", "update"],
    ["local-wiki", "init"],
    ["local-wiki", "update"],
  ] as const)(
    "%s %s uses FilesystemBackend with no execute tool",
    (outputMode: OutputMode, command: Command) => {
      const backend = createRunBackend(false, outputMode, "/tmp/root");
      expect(backend).toBeInstanceOf(FilesystemBackend);
      expect(backend).not.toBeInstanceOf(OpenWikiLocalShellBackend);

      const names = buildOpenWikiTools({
        cwd: "/tmp/root",
        outputMode,
        command,
      }).map((tool) => tool.name);
      expect(names).not.toContain("execute");
    },
  );

  test("chat uses the shell backend", () => {
    const backend = createRunBackend(true, "local-wiki", "/tmp/root");
    expect(backend).toBeInstanceOf(OpenWikiLocalShellBackend);
  });

  test("repository permissions allow /openwiki then deny everything else", () => {
    const permissions = createRunPermissions(false, "repository");
    expect(permissions).toEqual([
      { operations: ["write"], paths: ["/openwiki/**"] },
      { operations: ["write"], paths: ["/skills/**"], mode: "deny" },
      { operations: ["write"], paths: ["/**"], mode: "deny" },
    ]);
  });

  test("local-wiki permissions allow writes at the wiki root", () => {
    const permissions = createRunPermissions(false, "local-wiki");
    expect(permissions).toEqual([
      { operations: ["write"], paths: ["/skills/**"], mode: "deny" },
      { operations: ["write"], paths: ["/**"] },
    ]);
  });

  test("chat runs keep bundled skills read-only", () => {
    const expected = [
      { operations: ["write"], paths: ["/skills/**"], mode: "deny" },
    ];
    expect(createRunPermissions(true, "repository")).toEqual(expected);
    expect(createRunPermissions(true, "local-wiki")).toEqual(expected);
  });

  test("repository FilesystemBackend writes under /openwiki and blocks traversal", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-fs-repo-"));
    const backend = createRunBackend(false, "repository", rootDir);

    const docWrite = await backend.write("/openwiki/test.md", "ok");
    expect(docWrite.error).toBeUndefined();
    await expect(
      readFile(path.join(rootDir, "openwiki", "test.md"), "utf8"),
    ).resolves.toBe("ok");

    const traversal = await backend.write("/../escape.md", "bad");
    expect(traversal.error).toBeDefined();
  });

  test("local-wiki FilesystemBackend writes at the wiki root", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-fs-local-"));
    const backend = createRunBackend(false, "local-wiki", rootDir);

    const write = await backend.write("/test.md", "ok");
    expect(write.error).toBeUndefined();
    await expect(readFile(path.join(rootDir, "test.md"), "utf8")).resolves.toBe(
      "ok",
    );
  });

  test("git tools reject path traversal in filePath", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-git-reg-"));
    await mkdir(rootDir, { recursive: true });
    const tools = createGitReadOnlyTools({ cwd: rootDir });
    const gitShow = tools.find((tool) => tool.name === "openwiki_git_show");
    const result: unknown = await gitShow!.invoke({
      ref: "HEAD",
      filePath: "../../etc/passwd",
    });
    const output = typeof result === "string" ? result : JSON.stringify(result);
    expect(output).toContain("'..'");
  });

  test("resolveWithinRoot handles backslash separators without escaping", () => {
    const root = path.resolve("/tmp/some-root");
    const resolved = resolveWithinRoot("src\\nested\\file.ts", root);
    expect(resolved).toBe(path.join(root, "src", "nested", "file.ts"));

    expect(() => resolveWithinRoot("..\\..\\escape", root)).toThrow();
  });
});
