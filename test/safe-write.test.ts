import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { writeGeneratedFile } from "../src/safe-write.ts";

const tempDirs: string[] = [];

async function createTempRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "openwiki-safe-write-"));
  tempDirs.push(repo);
  return repo;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("writeGeneratedFile (symlink-following guard)", () => {
  test("writes a normal file inside the repo, creating parents", async () => {
    const repo = await createTempRepo();
    const target = path.join(repo, "openwiki", "workspaces.md");
    await writeGeneratedFile(repo, target, "hello\n");
    expect(await readFile(target, "utf8")).toBe("hello\n");
  });

  test("refuses to follow a symlinked destination and does not clobber its target", async () => {
    const repo = await createTempRepo();
    const outside = await createTempRepo();
    const victim = path.join(outside, "victim.txt");
    await writeFile(victim, "original\n");

    // A malicious repo commits the destination as a symlink to a file outside
    // the repo; the write must refuse rather than follow it (CWE-59).
    await mkdir(path.join(repo, "openwiki"), { recursive: true });
    const link = path.join(repo, "openwiki", "workspaces.md");
    await symlink(victim, link);

    await expect(
      writeGeneratedFile(repo, link, "attacker content\n"),
    ).rejects.toThrow(/symlink/);
    // The link target outside the repo is untouched.
    expect(await readFile(victim, "utf8")).toBe("original\n");
    // The path on disk is still a symlink, never overwritten as a real file.
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  test("refuses a symlinked destination at the repo root (e.g. a workflow file)", async () => {
    const repo = await createTempRepo();
    const outside = await createTempRepo();
    const victim = path.join(outside, "authorized_keys");
    await writeFile(victim, "original-key\n");

    // Mirrors the .github/workflows/openwiki-update.yml attack: a repo-root
    // path committed as a symlink pointing outside the repo.
    await mkdir(path.join(repo, ".github", "workflows"), { recursive: true });
    const link = path.join(repo, ".github", "workflows", "openwiki-update.yml");
    await symlink(victim, link);

    await expect(
      writeGeneratedFile(repo, link, "name: pwned\n"),
    ).rejects.toThrow(/symlink/);
    expect(await readFile(victim, "utf8")).toBe("original-key\n");
  });

  test("refuses when the parent directory resolves outside the repo", async () => {
    const repo = await createTempRepo();
    const outside = await createTempRepo();
    // openwiki/ itself is a symlink to a directory outside the repo, so the
    // resolved write parent escapes the repository.
    await symlink(outside, path.join(repo, "openwiki"));

    await expect(
      writeGeneratedFile(
        repo,
        path.join(repo, "openwiki", "workspaces.md"),
        "x\n",
      ),
    ).rejects.toThrow(/outside the repository/);
  });
});
