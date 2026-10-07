import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  persistRepositoryWikiConfig,
  readRepositoryWikiConfig,
  readRepositoryWikiConfigSync,
  REPOSITORY_WIKI_CONFIG_FILE,
  RepositoryWikiConfigError,
  resolveRepositoryWikiLocation,
  resolveRepositoryWikiLocationSync,
} from "../../src/repository-wiki/config.ts";

/**
 * Creates an isolated repository root for one configuration test.
 */
async function repositoryRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "openwiki-repository-config-"));
}

describe("repository wiki configuration", () => {
  test("uses openwiki when configuration is absent", async () => {
    const root = await repositoryRoot();
    await expect(readRepositoryWikiConfig(root)).resolves.toBeNull();
    await expect(resolveRepositoryWikiLocation(root)).resolves.toEqual({
      directory: "openwiki",
      root: path.join(root, "openwiki"),
      source: "default",
    });
  });

  test("reads and normalizes strict custom configuration", async () => {
    const root = await repositoryRoot();
    await writeFile(
      path.join(root, REPOSITORY_WIKI_CONFIG_FILE),
      '{"wikiDirectory":"docs\\\\wiki"}\n',
    );

    await expect(readRepositoryWikiConfig(root)).resolves.toEqual({
      wikiDirectory: "docs/wiki",
    });
    await expect(resolveRepositoryWikiLocation(root)).resolves.toEqual({
      directory: "docs/wiki",
      root: path.join(root, "docs", "wiki"),
      source: "config",
    });
  });

  test("supports descriptor-backed synchronous startup resolution", async () => {
    const root = await repositoryRoot();
    await writeFile(
      path.join(root, REPOSITORY_WIKI_CONFIG_FILE),
      '{"wikiDirectory":"docs/wiki"}\n',
    );

    expect(readRepositoryWikiConfigSync(root)).toEqual({
      wikiDirectory: "docs/wiki",
    });
    expect(resolveRepositoryWikiLocationSync(root)).toEqual({
      directory: "docs/wiki",
      root: path.join(root, "docs/wiki"),
      source: "config",
    });
  });

  test("uses an explicit selection when configuration is absent", async () => {
    const root = await repositoryRoot();
    await expect(resolveRepositoryWikiLocation(root, "wiki")).resolves.toEqual({
      directory: "wiki",
      root: path.join(root, "wiki"),
      source: "option",
    });
  });

  test("lets matching durable configuration remain authoritative", async () => {
    const root = await repositoryRoot();
    await writeFile(
      path.join(root, REPOSITORY_WIKI_CONFIG_FILE),
      '{"wikiDirectory":"docs"}\n',
    );
    await expect(resolveRepositoryWikiLocation(root, "docs")).resolves.toEqual({
      directory: "docs",
      root: path.join(root, "docs"),
      source: "config",
    });
  });

  test("rejects a conflicting explicit selection", async () => {
    const root = await repositoryRoot();
    await writeFile(
      path.join(root, REPOSITORY_WIKI_CONFIG_FILE),
      '{"wikiDirectory":"docs"}\n',
    );
    await expect(resolveRepositoryWikiLocation(root, "wiki")).rejects.toThrow(
      "Moving a repository wiki is not supported",
    );
  });

  test.each([
    ["invalid JSON", "{"],
    ["an array", "[]"],
    ["a null value", "null"],
    ["a non-string directory", '{"wikiDirectory":1}'],
    ["an unknown field", '{"wikiDirectory":"docs","extra":true}'],
    ["a missing field", "{}"],
    ["a prototype key", '{"wikiDirectory":"docs","__proto__":{}}'],
    ["an unsafe directory", '{"wikiDirectory":"../docs"}'],
  ])("rejects %s", async (_description, content) => {
    const root = await repositoryRoot();
    await writeFile(path.join(root, REPOSITORY_WIKI_CONFIG_FILE), content);
    await expect(readRepositoryWikiConfig(root)).rejects.toThrow();
  });

  test("reports unsafe configured directories as config errors", async () => {
    const root = await repositoryRoot();
    await writeFile(
      path.join(root, REPOSITORY_WIKI_CONFIG_FILE),
      '{"wikiDirectory":"../docs"}',
    );
    await expect(readRepositoryWikiConfig(root)).rejects.toThrow(
      "Invalid .openwiki.json",
    );
  });

  test("rejects an oversized config before parsing", async () => {
    const root = await repositoryRoot();
    await writeFile(
      path.join(root, REPOSITORY_WIKI_CONFIG_FILE),
      " ".repeat(16 * 1024 + 1),
    );
    await expect(readRepositoryWikiConfig(root)).rejects.toThrow(
      "must not exceed 16384 bytes",
    );
  });

  test("rejects config symlinks and non-files", async () => {
    const symlinkRoot = await repositoryRoot();
    await writeFile(path.join(symlinkRoot, "target.json"), "{}\n");
    await symlink(
      "target.json",
      path.join(symlinkRoot, REPOSITORY_WIKI_CONFIG_FILE),
    );
    await expect(readRepositoryWikiConfig(symlinkRoot)).rejects.toThrow(
      "cannot be a symbolic link",
    );

    const directoryRoot = await repositoryRoot();
    await mkdir(path.join(directoryRoot, REPOSITORY_WIKI_CONFIG_FILE));
    await expect(readRepositoryWikiConfig(directoryRoot)).rejects.toThrow(
      "must be a regular file",
    );
  });

  test("requires an absolute repository root", async () => {
    await expect(readRepositoryWikiConfig("relative")).rejects.toThrow(
      RepositoryWikiConfigError,
    );
  });

  test("atomically persists formatted custom configuration", async () => {
    const root = await repositoryRoot();
    await persistRepositoryWikiConfig(root, "docs\\wiki");
    await expect(
      readFile(path.join(root, REPOSITORY_WIKI_CONFIG_FILE), "utf8"),
    ).resolves.toBe('{\n  "wikiDirectory": "docs/wiki"\n}\n');
    await expect(readRepositoryWikiConfig(root)).resolves.toEqual({
      wikiDirectory: "docs/wiki",
    });
  });

  test("preserves matching existing configuration and its mode bits", async () => {
    const root = await repositoryRoot();
    const file = path.join(root, REPOSITORY_WIKI_CONFIG_FILE);
    await writeFile(file, '{"wikiDirectory":"docs"}\n');
    await chmod(file, 0o600);
    await persistRepositoryWikiConfig(root, "docs");
    const handle = await open(file, "r");
    try {
      const metadata = await handle.stat();
      expect(metadata.mode & 0o777).toBe(0o600);
      await expect(handle.readFile("utf8")).resolves.toBe(
        '{"wikiDirectory":"docs"}\n',
      );
    } finally {
      await handle.close();
    }
  });

  test("refuses to overwrite a conflicting existing configuration", async () => {
    const root = await repositoryRoot();
    const file = path.join(root, REPOSITORY_WIKI_CONFIG_FILE);
    await writeFile(file, '{"wikiDirectory":"docs"}\n');

    await expect(persistRepositoryWikiConfig(root, "wiki")).rejects.toThrow(
      "Moving a repository wiki is not supported",
    );
    await expect(readFile(file, "utf8")).resolves.toBe(
      '{"wikiDirectory":"docs"}\n',
    );
  });

  test("does not create config for the implicit default", async () => {
    const root = await repositoryRoot();
    await persistRepositoryWikiConfig(root, "openwiki");
    await expect(
      readFile(path.join(root, REPOSITORY_WIKI_CONFIG_FILE), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("refuses to replace an existing config symlink", async () => {
    const root = await repositoryRoot();
    await writeFile(path.join(root, "target.json"), "{}\n");
    await symlink("target.json", path.join(root, REPOSITORY_WIKI_CONFIG_FILE));
    await expect(persistRepositoryWikiConfig(root, "docs")).rejects.toThrow(
      "cannot be a symbolic link",
    );
  });
});
