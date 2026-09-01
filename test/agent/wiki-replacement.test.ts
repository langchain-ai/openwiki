import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { beginRepositoryWikiReplacement } from "../../src/agent/wiki-replacement.ts";

describe("repository wiki replacement", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  async function createRepository(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "openwiki-replace-"));
    temporaryDirectories.push(root);
    return root;
  }

  test("starts an existing repository init from only the user-owned brief", async () => {
    const root = await createRepository();
    await mkdir(path.join(root, "openwiki/.claims"), { recursive: true });
    await writeFile(path.join(root, "openwiki/INSTRUCTIONS.md"), "# Brief\n");
    await writeFile(path.join(root, "openwiki/old.md"), "# Old\n");
    await writeFile(path.join(root, "openwiki/index.md"), "# Index\n");
    await writeFile(path.join(root, "openwiki/.claims/old.json"), "{}\n");
    await writeFile(path.join(root, "openwiki/.last-update.json"), "{}\n");

    const replacement = await beginRepositoryWikiReplacement(root);

    await expect(
      readFile(path.join(root, "openwiki/INSTRUCTIONS.md"), "utf8"),
    ).resolves.toBe("# Brief\n");
    await expect(
      readFile(path.join(root, "openwiki/old.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(path.join(root, "openwiki/.claims/old.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await replacement.commit();
  });

  test("restores the exact previous wiki after replacement failure", async () => {
    const root = await createRepository();
    await mkdir(path.join(root, "openwiki/.claims"), { recursive: true });
    await writeFile(path.join(root, "openwiki/INSTRUCTIONS.md"), "# Brief\n");
    await writeFile(path.join(root, "openwiki/old.md"), "# Old\n");
    await writeFile(
      path.join(root, "openwiki/.claims/old.json"),
      "old claims\n",
    );

    const replacement = await beginRepositoryWikiReplacement(root);
    await writeFile(path.join(root, "openwiki/new.md"), "# Partial\n");
    await replacement.rollback();

    await expect(
      readFile(path.join(root, "openwiki/old.md"), "utf8"),
    ).resolves.toBe("# Old\n");
    await expect(
      readFile(path.join(root, "openwiki/.claims/old.json"), "utf8"),
    ).resolves.toBe("old claims\n");
    await expect(
      readFile(path.join(root, "openwiki/new.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("restores the previous wiki before exiting on SIGINT", async () => {
    const root = await createRepository();
    await mkdir(path.join(root, "openwiki/.claims"), { recursive: true });
    await writeFile(path.join(root, "openwiki/old.md"), "# Old\n");
    await writeFile(
      path.join(root, "openwiki/.claims/old.json"),
      "old claims\n",
    );
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    await beginRepositoryWikiReplacement(root);
    await writeFile(path.join(root, "openwiki/partial.md"), "# Partial\n");
    process.emit("SIGINT");

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
    await expect(
      readFile(path.join(root, "openwiki/old.md"), "utf8"),
    ).resolves.toBe("# Old\n");
    await expect(
      readFile(path.join(root, "openwiki/.claims/old.json"), "utf8"),
    ).resolves.toBe("old claims\n");
    await expect(
      readFile(path.join(root, "openwiki/partial.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("does not make a first init transactional when no wiki exists", async () => {
    const root = await createRepository();
    const replacement = await beginRepositoryWikiReplacement(root);
    await mkdir(path.join(root, "openwiki"));
    await writeFile(path.join(root, "openwiki/partial.md"), "# Partial\n");

    await replacement.rollback();

    await expect(
      readFile(path.join(root, "openwiki/partial.md"), "utf8"),
    ).resolves.toBe("# Partial\n");
  });

  test("restores the wiki when its instructions cannot be preserved safely", async () => {
    const root = await createRepository();
    await mkdir(path.join(root, "openwiki"));
    await writeFile(path.join(root, "brief.md"), "# Outside brief\n");
    await writeFile(path.join(root, "openwiki/old.md"), "# Old\n");
    await symlink("../brief.md", path.join(root, "openwiki/INSTRUCTIONS.md"));

    await expect(beginRepositoryWikiReplacement(root)).rejects.toThrow(
      "expected a regular file",
    );

    await expect(
      readFile(path.join(root, "openwiki/old.md"), "utf8"),
    ).resolves.toBe("# Old\n");
    await expect(
      readFile(path.join(root, "openwiki/INSTRUCTIONS.md"), "utf8"),
    ).resolves.toBe("# Outside brief\n");
  });

  test("refuses a symlinked wiki root", async () => {
    const root = await createRepository();
    const target = await mkdtemp(path.join(tmpdir(), "openwiki-target-"));
    temporaryDirectories.push(target);
    await symlink(target, path.join(root, "openwiki"));

    await expect(beginRepositoryWikiReplacement(root)).rejects.toThrow(
      "expected a real directory",
    );
  });
});
