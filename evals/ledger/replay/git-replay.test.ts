import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { WorktreeSafetyError } from "../core/errors.js";
import { GitReplay } from "./git-replay.js";
import { createTinyRepo, type TinyRepo } from "../testing/tiny-repo.js";
import {
  assertContainedByRealpath,
  createWorkspace,
  type Workspace,
} from "./workspace.js";

describe("assertContainedByRealpath", () => {
  test("accepts a path inside the root and rejects one outside", async () => {
    const root = await import("node:fs/promises").then((fs) =>
      fs.mkdtemp(path.join(os.tmpdir(), "ledger-guard-")),
    );
    const inside = path.join(root, "a", "b");

    await mkdir(inside, { recursive: true });

    await expect(
      assertContainedByRealpath(root, inside),
    ).resolves.toBeUndefined();
    await expect(
      assertContainedByRealpath(root, os.tmpdir()),
    ).rejects.toBeInstanceOf(WorktreeSafetyError);
  });

  test("rejects a symlink inside the root that resolves outside it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ledger-guard-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "ledger-out-"));
    const link = path.join(root, "escape");

    // A symlink that lives inside the root but points outside it. A raw
    // string-prefix check on the link path would wrongly accept it; realpath
    // resolution is what catches the escape. This is the guard's whole purpose.
    await symlink(outside, link);

    try {
      await expect(
        assertContainedByRealpath(root, link),
      ).rejects.toBeInstanceOf(WorktreeSafetyError);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("rejects a not-yet-created target beneath a symlinked parent that escapes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ledger-guard-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "ledger-out-"));
    const linkedParent = path.join(root, "parent-link");

    await symlink(outside, linkedParent);
    const target = path.join(linkedParent, "not-created-yet");

    // The target does not exist, so the guard resolves the realpath of its parent
    // and re-attaches the basename. The parent is a symlink out of the root, so a
    // path about to be created there must still be refused.
    try {
      await expect(
        assertContainedByRealpath(root, target),
      ).rejects.toBeInstanceOf(WorktreeSafetyError);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("accepts a not-yet-created target inside the root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ledger-guard-"));
    const parent = path.join(root, "child");

    await mkdir(parent, { recursive: true });
    const target = path.join(parent, "leaf");

    // "leaf" does not exist yet, but its parent does and is genuinely inside the
    // root, so the parent-realpath branch must accept it. This is the
    // worktree-about-to-be-created case create() relies on.
    try {
      await expect(
        assertContainedByRealpath(root, target),
      ).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("GitReplay", () => {
  let repo: TinyRepo;
  let workspace: Workspace;

  beforeEach(async () => {
    repo = await createTinyRepo([
      { message: "v1", files: { "src.txt": "one\n" } },
      { message: "v2", files: { "src.txt": "two\n" } },
    ]);
    workspace = await createWorkspace();
  });

  afterEach(async () => {
    await workspace.dispose();
    await repo.dispose();
  });

  test("checks out the initial commit into an isolated worktree", async () => {
    const replay = await GitReplay.create(
      repo.repoPath,
      workspace.worktreeParent,
      repo.shas[0],
    );

    expect(
      replay.worktreeDir.startsWith(await realpathOf(workspace.root)),
    ).toBe(true);
    expect(
      await readFile(path.join(replay.worktreeDir, "src.txt"), "utf8"),
    ).toBe("one\n");

    await replay.teardown();
  });

  test("preserves the untracked wiki across a checkpoint checkout", async () => {
    const replay = await GitReplay.create(
      repo.repoPath,
      workspace.worktreeParent,
      repo.shas[0],
    );

    // Simulate a generated wiki: untracked files under openwiki/.
    const wikiFile = path.join(replay.worktreeDir, "openwiki", "page.md");

    await mkdir(path.dirname(wikiFile), { recursive: true });
    await writeFile(wikiFile, "generated knowledge", "utf8");

    await replay.checkout(repo.shas[1]);

    // Source advanced...
    expect(
      await readFile(path.join(replay.worktreeDir, "src.txt"), "utf8"),
    ).toBe("two\n");
    // ...but the untracked wiki survived, which is the longitudinal mechanism.
    expect(await readFile(wikiFile, "utf8")).toBe("generated knowledge");

    await replay.teardown();
  });

  test("continues after the original source repository is removed", async () => {
    const replay = await GitReplay.create(
      repo.repoPath,
      workspace.worktreeParent,
      repo.shas[0],
    );
    const laterCommit = repo.shas[1];

    await repo.dispose();
    await replay.checkout(laterCommit);

    expect(
      await readFile(path.join(replay.worktreeDir, "src.txt"), "utf8"),
    ).toBe("two\n");

    await replay.teardown();
  });

  test("rejects an invalid commit SHA", async () => {
    await expect(
      GitReplay.create(repo.repoPath, workspace.worktreeParent, "not-a-sha"),
    ).rejects.toThrow(/invalid commit SHA/);
  });

  test("resets a dirtied tracked file before checking out", async () => {
    const replay = await GitReplay.create(
      repo.repoPath,
      workspace.worktreeParent,
      repo.shas[0],
    );

    // A System Under Test that dirtied a tracked file would otherwise block the
    // checkout. checkout() runs `git reset --hard HEAD` first to clear it.
    await writeFile(
      path.join(replay.worktreeDir, "src.txt"),
      "dirtied\n",
      "utf8",
    );

    await replay.checkout(repo.shas[1]);

    expect(
      await readFile(path.join(replay.worktreeDir, "src.txt"), "utf8"),
    ).toBe("two\n");

    await replay.teardown();
  });

  test("accepts a checkpoint that does not track openwiki/", async () => {
    const replay = await GitReplay.create(
      repo.repoPath,
      workspace.worktreeParent,
      repo.shas[0],
    );

    await expect(
      replay.assertWikiNotTrackedAt(repo.shas[0]),
    ).resolves.toBeUndefined();

    await replay.teardown();
  });

  test("rejects a checkpoint that tracks openwiki/", async () => {
    const tracked = await createTinyRepo([
      {
        message: "wiki committed by mistake",
        files: { "src.txt": "one\n", "openwiki/page.md": "tracked" },
      },
    ]);
    const trackedWorkspace = await createWorkspace();

    try {
      const replay = await GitReplay.create(
        tracked.repoPath,
        trackedWorkspace.worktreeParent,
        tracked.shas[0],
      );

      await expect(
        replay.assertWikiNotTrackedAt(tracked.shas[0]),
      ).rejects.toThrow(/openwiki/);

      await replay.teardown();
    } finally {
      await trackedWorkspace.dispose();
      await tracked.dispose();
    }
  });

  test("resolves a real commit and rejects an unresolvable SHA", async () => {
    const replay = await GitReplay.create(
      repo.repoPath,
      workspace.worktreeParent,
      repo.shas[0],
    );

    await expect(
      replay.assertCommitResolves(repo.shas[0]),
    ).resolves.toBeUndefined();
    // Well-formed hex that resolves to no object in this repo.
    await expect(replay.assertCommitResolves("deadbeef")).rejects.toThrow(
      /does not resolve/,
    );

    await replay.teardown();
  });

  test("accepts an ancestor pair and rejects a reversed one", async () => {
    const replay = await GitReplay.create(
      repo.repoPath,
      workspace.worktreeParent,
      repo.shas[0],
    );

    // shas[0] (v1) is the parent of shas[1] (v2).
    await expect(
      replay.assertAncestor(repo.shas[0], repo.shas[1]),
    ).resolves.toBeUndefined();
    await expect(
      replay.assertAncestor(repo.shas[1], repo.shas[0]),
    ).rejects.toThrow(/not a Git ancestor/);

    await replay.teardown();
  });
});

/**
 * Resolve a realpath for prefix comparison in the isolation assertion.
 */
async function realpathOf(target: string): Promise<string> {
  return (await import("node:fs/promises")).realpath(target);
}
