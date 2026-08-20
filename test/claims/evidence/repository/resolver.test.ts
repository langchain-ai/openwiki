import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { OpenWikiIgnore } from "../../../../src/agent/openwiki-ignore.ts";
import {
  EvidenceResolutionError,
  EvidenceResourceError,
  EvidenceSecurityError,
} from "../../../../src/claims/core/errors.ts";
import { RepositoryEvidenceResolver } from "../../../../src/claims/evidence/repository/resolver.ts";

describe("RepositoryEvidenceResolver", () => {
  let rootDir: string;
  let cleanupDirectories: string[];

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "openwiki-claims-repo-"));
    cleanupDirectories = [rootDir];
  });

  afterEach(async () => {
    await Promise.all(
      cleanupDirectories.map((directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
    );
  });

  /**
   * Writes a repository fixture, creating its parent directories.
   *
   * @param relativePath - Repository-relative fixture path.
   * @param content - Complete fixture contents.
   */
  async function writeFixture(
    relativePath: string,
    content: string,
  ): Promise<void> {
    const absolutePath = path.join(rootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }

  test("hashes explicit whole-file evidence deterministically", async () => {
    await writeFixture("notes.txt", "stable evidence\n");
    const resolver = new RepositoryEvidenceResolver({ rootDir });

    const first = await resolver.resolve("repo://notes.txt");
    const second = await resolver.resolve("repo://notes.txt");

    expect(first).toEqual(second);
    expect(first?.evidence.resource).toBe("repo://notes.txt");
    expect(first?.evidence.version).toMatch(
      /^repo-file-v1:sha256:[a-f0-9]{64}$/u,
    );
    expect(first?.content).toBe("stable evidence\n");
  });

  test("resolves exact line ranges for any text-file extension", async () => {
    await writeFixture(
      "fixture.unknown-language",
      "header\nfirst evidence\nsecond evidence\nfooter\n",
    );
    const resolver = new RepositoryEvidenceResolver({ rootDir });

    const resolved = await resolver.resolve(
      "repo://fixture.unknown-language#L2-L3",
    );

    expect(resolved?.evidence.resource).toBe(
      "repo://fixture.unknown-language#L2-L3",
    );
    expect(resolved?.evidence.version).toMatch(
      /^repo-lines-v1:sha256:[a-f0-9]{64}:[A-Za-z0-9_-]+$/u,
    );
    expect(resolved?.content).toBe("first evidence\nsecond evidence\n");
  });

  test("canonicalizes single-line range identities", async () => {
    await writeFixture("fixture.txt", "first\nsecond\n");
    const resolver = new RepositoryEvidenceResolver({ rootDir });

    const resolved = await resolver.resolve("repo://fixture.txt#L2");

    expect(resolved?.evidence.resource).toBe("repo://fixture.txt#L2-L2");
    expect(resolved?.content).toBe("second\n");
  });

  test("returns null for missing files, directories, and invalid current ranges", async () => {
    await mkdir(path.join(rootDir, "directory"));
    await writeFixture("fixture.txt", "only one line\n");
    const resolver = new RepositoryEvidenceResolver({ rootDir });

    await expect(resolver.resolve("repo://missing.txt")).resolves.toBeNull();
    await expect(resolver.resolve("repo://directory")).resolves.toBeNull();
    await expect(
      resolver.resolve("repo://fixture.txt#L1-L2"),
    ).resolves.toBeNull();
  });

  test("keeps unchanged evidence fresh when lines move", async () => {
    const original =
      "before one\nbefore two\nbefore three\ntarget one\ntarget two\nafter one\nafter two\nafter three\n";
    await writeFixture("fixture.any", original);
    const resolver = new RepositoryEvidenceResolver({ rootDir });
    const before = await resolver.resolve("repo://fixture.any#L4-L5");

    await writeFixture(
      "fixture.any",
      `inserted one\ninserted two\n${original}`,
    );
    const moved = await resolver.resolve(
      "repo://fixture.any#L4-L5",
      before?.evidence.version,
    );

    expect(moved?.content).toBe("target one\ntarget two\n");
    expect(moved?.evidence.version).toBe(before?.evidence.version);
  });

  test("ignores unrelated edits outside an unchanged selected range", async () => {
    await writeFixture(
      "fixture.any",
      "before one\nbefore two\nbefore three\ntarget one\ntarget two\nafter one\nafter two\nafter three\n",
    );
    const resolver = new RepositoryEvidenceResolver({ rootDir });
    const before = await resolver.resolve("repo://fixture.any#L4-L5");

    await writeFixture(
      "fixture.any",
      "changed before\nbefore two\nbefore three\ntarget one\ntarget two\nafter one\nafter two\nchanged after\n",
    );
    const current = await resolver.resolve(
      "repo://fixture.any#L4-L5",
      before?.evidence.version,
    );

    expect(current?.evidence.version).toBe(before?.evidence.version);
    expect(current?.content).toBe("target one\ntarget two\n");
  });

  test("marks edits inside a uniquely anchored range stale", async () => {
    await writeFixture(
      "fixture.any",
      "before one\nbefore two\nbefore three\ntarget one\ntarget two\nafter one\nafter two\nafter three\n",
    );
    const resolver = new RepositoryEvidenceResolver({ rootDir });
    const before = await resolver.resolve("repo://fixture.any#L4-L5");

    await writeFixture(
      "fixture.any",
      "before one\nbefore two\nbefore three\ntarget changed\ntarget two\nafter one\nafter two\nafter three\n",
    );
    const changed = await resolver.resolve(
      "repo://fixture.any#L4-L5",
      before?.evidence.version,
    );

    expect(changed?.content).toBe("target changed\ntarget two\n");
    expect(changed?.evidence.version).not.toBe(before?.evidence.version);
  });

  test("relocates a changed range whose line count grows", async () => {
    await writeFixture(
      "fixture.any",
      "before one\nbefore two\nbefore three\ntarget one\ntarget two\nafter one\nafter two\nafter three\n",
    );
    const resolver = new RepositoryEvidenceResolver({ rootDir });
    const before = await resolver.resolve("repo://fixture.any#L4-L5");

    await writeFixture(
      "fixture.any",
      "before one\nbefore two\nbefore three\ntarget one\nnew target line\ntarget two\nafter one\nafter two\nafter three\n",
    );
    const changed = await resolver.resolve(
      "repo://fixture.any#L4-L5",
      before?.evidence.version,
    );

    expect(changed?.content).toBe("target one\nnew target line\ntarget two\n");
    expect(changed?.evidence.version).not.toBe(before?.evidence.version);
  });

  test("returns null when an anchored range is deleted", async () => {
    await writeFixture(
      "fixture.any",
      "before one\nbefore two\nbefore three\ntarget one\ntarget two\nafter one\nafter two\nafter three\n",
    );
    const resolver = new RepositoryEvidenceResolver({ rootDir });
    const before = await resolver.resolve("repo://fixture.any#L4-L5");

    await writeFixture(
      "fixture.any",
      "before one\nbefore two\nbefore three\nafter one\nafter two\nafter three\n",
    );

    await expect(
      resolver.resolve("repo://fixture.any#L4-L5", before?.evidence.version),
    ).resolves.toBeNull();
  });

  test("returns null instead of guessing between ambiguous anchors", async () => {
    const context =
      "before one\nbefore two\nbefore three\nTARGET\nafter one\nafter two\nafter three\n";
    await writeFixture("fixture.any", context);
    const resolver = new RepositoryEvidenceResolver({ rootDir });
    const before = await resolver.resolve("repo://fixture.any#L4-L4");

    const changedBlock = context.replace("TARGET\n", "CHANGED\n");
    await writeFixture("fixture.any", `${changedBlock}${changedBlock}`);

    await expect(
      resolver.resolve("repo://fixture.any#L4-L4", before?.evidence.version),
    ).resolves.toBeNull();
  });

  test("falls back to the current line hint for an unknown prior version", async () => {
    await writeFixture("fixture.any", "first\nsecond\nthird\n");
    const resolver = new RepositoryEvidenceResolver({ rootDir });

    const resolved = await resolver.resolve(
      "repo://fixture.any#L2-L2",
      "unknown-version",
    );

    expect(resolved?.content).toBe("second\n");
    expect(resolved?.evidence.version).toMatch(/^repo-lines-v1:/u);
  });

  test("rejects ignored evidence", async () => {
    await writeFixture("private/secret.lang", "secret\n");
    const resolver = new RepositoryEvidenceResolver({
      rootDir,
      openWikiIgnore: new OpenWikiIgnore(["private/"]),
    });

    await expect(
      resolver.resolve("repo://private/secret.lang#L1-L1"),
    ).rejects.toThrow(EvidenceResourceError);
  });

  test("rejects direct symbolic links", async () => {
    await writeFixture("target.lang", "target\n");
    await symlink("target.lang", path.join(rootDir, "link.lang"));
    const resolver = new RepositoryEvidenceResolver({ rootDir });

    await expect(resolver.resolve("repo://link.lang#L1-L1")).rejects.toThrow(
      EvidenceSecurityError,
    );
  });

  test("rejects paths that escape through a parent symbolic link", async () => {
    const outsideDir = await mkdtemp(
      path.join(tmpdir(), "openwiki-claims-outside-"),
    );
    cleanupDirectories.push(outsideDir);
    await writeFile(path.join(outsideDir, "secret.lang"), "secret\n", "utf8");
    await symlink(outsideDir, path.join(rootDir, "escape"), "dir");
    const resolver = new RepositoryEvidenceResolver({ rootDir });

    await expect(
      resolver.resolve("repo://escape/secret.lang#L1-L1"),
    ).rejects.toThrow(EvidenceResolutionError);
  });

  test("rejects parent symbolic links even inside the repository", async () => {
    await writeFixture("actual/value.lang", "value\n");
    await symlink("actual", path.join(rootDir, "alias"), "dir");
    const resolver = new RepositoryEvidenceResolver({ rootDir });

    await expect(
      resolver.resolve("repo://alias/value.lang#L1-L1"),
    ).rejects.toThrow(EvidenceResolutionError);
  });

  test("rejects alternate-case filesystem aliases when they resolve", async () => {
    await writeFixture("CaseSensitive.lang", "value\n");
    const resolver = new RepositoryEvidenceResolver({ rootDir });
    const aliasResource = "repo://casesensitive.lang#L1-L1";
    let aliasExists = true;
    try {
      await writeFile(path.join(rootDir, "casesensitive.lang"), "", {
        flag: "ax",
      });
      aliasExists = false;
      await rm(path.join(rootDir, "casesensitive.lang"));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
    }

    if (aliasExists) {
      await expect(resolver.resolve(aliasResource)).rejects.toThrow(
        EvidenceResolutionError,
      );
    } else {
      await expect(resolver.resolve(aliasResource)).resolves.toBeNull();
    }
  });

  test("persists canonical repository resource identities", async () => {
    await writeFixture("src/value.txt", "evidence\n");
    const resolver = new RepositoryEvidenceResolver({ rootDir });

    const resolved = await resolver.resolve("repo://src\\value%2Etxt#L1");

    expect(resolved?.evidence.resource).toBe("repo://src/value.txt#L1-L1");
  });

  test("rejects lexical traversal before touching the filesystem", async () => {
    const resolver = new RepositoryEvidenceResolver({ rootDir });

    await expect(resolver.resolve("repo://../secret.lang")).rejects.toThrow(
      EvidenceResourceError,
    );
  });
});
