import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveRepositoryRoot } from "../../src/integrations/core/repository-root.ts";

const temporaryRoots: string[] = [];

/**
 * Creates an isolated Git worktree.
 *
 * @returns Canonical temporary repository path.
 */
async function createRepository(): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "openwiki-root-")),
  );
  temporaryRoots.push(root);
  execFileSync("git", ["init", "--quiet", root]);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("host repository root resolution", () => {
  test("canonicalizes a repository subdirectory to the Git top level", async () => {
    const root = await createRepository();
    const nested = path.join(root, "packages/example");
    await mkdir(nested, { recursive: true });

    await expect(resolveRepositoryRoot(nested)).resolves.toBe(root);
  });

  test("requires an explicit absolute path", async () => {
    await expect(resolveRepositoryRoot(".")).rejects.toMatchObject({
      code: "invalid_input",
      message:
        "The OpenWiki root must be an absolute path inside a Git repository.",
    });
  });

  test("rejects missing, non-directory, and non-repository paths safely", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-nonrepo-"));
    temporaryRoots.push(root);
    const file = path.join(root, "private-file-name");
    await writeFile(file, "private\n", "utf8");

    await expect(
      resolveRepositoryRoot(path.join(root, "private-missing-name")),
    ).rejects.toMatchObject({
      message: "The OpenWiki root must be an existing directory.",
    });
    await expect(resolveRepositoryRoot(file)).rejects.toMatchObject({
      message: "The OpenWiki root must be a directory.",
    });
    await expect(resolveRepositoryRoot(root)).rejects.toMatchObject({
      message: "The OpenWiki root must be inside a Git repository.",
    });
  });

  test("refuses a Git worktree that resolves to the home directory", async () => {
    const root = await createRepository();
    vi.spyOn(os, "homedir").mockReturnValue(root);

    await expect(resolveRepositoryRoot(root)).rejects.toMatchObject({
      code: "invalid_input",
      message:
        "OpenWiki refuses to use the filesystem root or home directory as a repository root.",
    });
  });
});
