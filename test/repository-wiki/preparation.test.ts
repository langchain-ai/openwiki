import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  readRepositoryWikiConfig,
  REPOSITORY_WIKI_CONFIG_FILE,
} from "../../src/repository-wiki/config.ts";
import { prepareRepositoryWikiLocation } from "../../src/repository-wiki/preparation.ts";

/**
 * Creates an isolated repository root for one preparation test.
 */
async function repositoryRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "openwiki-repository-preparation-"));
}

describe("repository wiki preparation", () => {
  test("prepares the implicit default without creating configuration", async () => {
    const root = await repositoryRoot();

    await expect(
      prepareRepositoryWikiLocation(root, { mode: "init" }),
    ).resolves.toEqual({
      location: {
        directory: "openwiki",
        root: path.join(root, "openwiki"),
        source: "default",
      },
      configAction: "none",
    });
    await expect(
      readFile(path.join(root, REPOSITORY_WIKI_CONFIG_FILE), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each([
    ["absent", null],
    ["empty", "empty"],
    ["instructions-only", "instructions"],
    ["managed", "managed"],
  ])(
    "prepares a custom init target classified as %s",
    async (status, setup) => {
      const root = await repositoryRoot();
      const target = path.join(root, "docs");
      if (setup === "empty") {
        await mkdir(target);
      } else if (setup === "instructions") {
        await mkdir(target);
        await writeFile(path.join(target, "INSTRUCTIONS.md"), "# Goal\n");
      } else if (setup === "managed") {
        await mkdir(target);
        await writeFile(path.join(target, ".run.json"), "{}\n");
      }

      await expect(
        prepareRepositoryWikiLocation(root, {
          mode: "init",
          requestedDirectory: "docs",
        }),
      ).resolves.toMatchObject({
        location: {
          directory: "docs",
          root: target,
          source: "option",
        },
        configAction: "persisted",
        ownership: { status },
      });
      await expect(readRepositoryWikiConfig(root)).resolves.toEqual({
        wikiDirectory: "docs",
      });
    },
  );

  test("refuses unmanaged custom init targets before writing configuration", async () => {
    const root = await repositoryRoot();
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "docs", "notes.md"), "# Notes\n");

    await expect(
      prepareRepositoryWikiLocation(root, {
        mode: "init",
        requestedDirectory: "docs",
      }),
    ).rejects.toThrow("unmanaged entries");
    await expect(readRepositoryWikiConfig(root)).resolves.toBeNull();
  });

  test("refuses unsafe custom init targets before writing configuration", async () => {
    const root = await repositoryRoot();
    const external = await repositoryRoot();
    await symlink(external, path.join(root, "docs"));

    await expect(
      prepareRepositoryWikiLocation(root, {
        mode: "init",
        requestedDirectory: "docs",
      }),
    ).rejects.toThrow("symbolic link");
    await expect(readRepositoryWikiConfig(root)).resolves.toBeNull();
  });

  test("recovers updates only from an existing managed custom wiki", async () => {
    const managedRoot = await repositoryRoot();
    await mkdir(path.join(managedRoot, "docs"));
    await writeFile(path.join(managedRoot, "docs", ".run.json"), "{}\n");

    await expect(
      prepareRepositoryWikiLocation(managedRoot, {
        mode: "update",
        requestedDirectory: "docs",
      }),
    ).resolves.toMatchObject({
      configAction: "persisted",
      ownership: { status: "managed" },
    });

    const absentRoot = await repositoryRoot();
    await expect(
      prepareRepositoryWikiLocation(absentRoot, {
        mode: "update",
        requestedDirectory: "docs",
      }),
    ).rejects.toThrow("not an existing OpenWiki-managed wiki");
    await expect(readRepositoryWikiConfig(absentRoot)).resolves.toBeNull();
  });

  test("plans a dry-run config write without persisting it", async () => {
    const root = await repositoryRoot();

    await expect(
      prepareRepositoryWikiLocation(root, {
        mode: "init",
        requestedDirectory: "docs",
        dryRun: true,
      }),
    ).resolves.toMatchObject({
      configAction: "planned",
      ownership: { status: "absent" },
    });
    await expect(readRepositoryWikiConfig(root)).resolves.toBeNull();
  });

  test("honors matching config and rejects conflicting frontend requests", async () => {
    const root = await repositoryRoot();
    await writeFile(
      path.join(root, REPOSITORY_WIKI_CONFIG_FILE),
      '{"wikiDirectory":"docs"}\n',
    );

    await expect(
      prepareRepositoryWikiLocation(root, {
        mode: "update",
        requestedDirectory: "docs",
      }),
    ).resolves.toMatchObject({
      location: { directory: "docs", source: "config" },
      configAction: "none",
    });
    await expect(
      prepareRepositoryWikiLocation(root, {
        mode: "update",
        requestedDirectory: "wiki",
      }),
    ).rejects.toThrow("Moving a repository wiki is not supported");
  });
});
