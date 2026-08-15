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

import { afterEach, describe, expect, test } from "vitest";

import { captureArtifact } from "./artifact.js";
import { OPEN_WIKI_DIR } from "../core/paths.js";

/**
 * SHA-256 of the empty input: the fingerprint of a run that produced no
 * knowledge documents at all.
 */
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("captureArtifact", () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanups
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  /**
   * Create a throwaway worktree populated with the given wiki files (paths
   * relative to the `openwiki/` directory) plus a separate artifacts root, both
   * registered for cleanup.
   *
   * @param files - Wiki file contents keyed by `openwiki/`-relative path.
   *
   * @returns The worktree directory and the artifacts root.
   */
  async function scratch(
    files: Record<string, string>,
  ): Promise<{ worktreeDir: string; artifactsRoot: string }> {
    const worktreeDir = await mkdtemp(path.join(os.tmpdir(), "ledger-wt-"));
    const artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "ledger-art-"));

    cleanups.push(worktreeDir, artifactsRoot);

    for (const [relativePath, content] of Object.entries(files)) {
      const absolute = path.join(worktreeDir, OPEN_WIKI_DIR, relativePath);

      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content, "utf8");
    }

    return { worktreeDir, artifactsRoot };
  }

  test("captures nested documents sorted by path and skips dot-entries", async () => {
    const { worktreeDir, artifactsRoot } = await scratch({
      "b.md": "beta",
      "a.md": "alpha",
      "sub/c.md": "gamma",
      ".hidden.md": "secret",
      ".git/config": "no",
    });

    const artifact = await captureArtifact("T0", worktreeDir, artifactsRoot);

    // Sorted by relativePath; the dot-file and the dot-directory are both skipped.
    expect(artifact.documents).toEqual([
      { relativePath: "a.md", content: "alpha" },
      { relativePath: "b.md", content: "beta" },
      { relativePath: "sub/c.md", content: "gamma" },
    ]);
    expect(artifact.checkpointId).toBe("T0");
    expect(artifact.snapshotDir).toBe(path.join(artifactsRoot, "T0"));
    expect(artifact.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  test("writes immutable snapshot copies under the artifacts root", async () => {
    const { worktreeDir, artifactsRoot } = await scratch({
      "sub/c.md": "gamma",
    });

    const artifact = await captureArtifact("T0", worktreeDir, artifactsRoot);

    // The snapshot copy the evaluator later reads is a private duplicate under the
    // artifacts root, not the worktree file itself.
    expect(
      await readFile(path.join(artifact.snapshotDir, "sub", "c.md"), "utf8"),
    ).toBe("gamma");
  });

  test("rejects a checkpoint path that escapes the artifacts root", async () => {
    const { worktreeDir, artifactsRoot } = await scratch({
      "a.md": "must remain contained",
    });

    await expect(
      captureArtifact("../escaped", worktreeDir, artifactsRoot),
    ).rejects.toThrow(/Refusing to write checkpoint artifact outside/u);
  });

  test("fingerprints identical content the same and changed content differently", async () => {
    const one = await scratch({ "a.md": "alpha", "b.md": "beta" });
    const two = await scratch({ "a.md": "alpha", "b.md": "beta" });
    const three = await scratch({ "a.md": "alpha", "b.md": "BETA" });

    const a = await captureArtifact("T0", one.worktreeDir, one.artifactsRoot);
    const b = await captureArtifact("T0", two.worktreeDir, two.artifactsRoot);
    const c = await captureArtifact(
      "T0",
      three.worktreeDir,
      three.artifactsRoot,
    );

    expect(b.fingerprint).toBe(a.fingerprint);
    expect(c.fingerprint).not.toBe(a.fingerprint);
  });

  test("treats a missing wiki directory as an empty artifact and still creates the snapshot dir", async () => {
    const worktreeDir = await mkdtemp(path.join(os.tmpdir(), "ledger-wt-"));
    const artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "ledger-art-"));

    cleanups.push(worktreeDir, artifactsRoot);

    // No openwiki/ directory exists in this worktree at all.
    const artifact = await captureArtifact("T1", worktreeDir, artifactsRoot);

    expect(artifact.documents).toEqual([]);
    expect(artifact.fingerprint).toBe(EMPTY_SHA256);
    // The evaluator backend needs a real directory to root at even for an empty run.
    expect((await stat(artifact.snapshotDir)).isDirectory()).toBe(true);
  });

  test("does not capture a symlink inside the wiki that points outside it", async () => {
    const { worktreeDir, artifactsRoot } = await scratch({ "a.md": "alpha" });
    const outside = await mkdtemp(path.join(os.tmpdir(), "ledger-out-"));
    const secret = path.join(outside, "secret.md");

    cleanups.push(outside);
    await writeFile(secret, "do not read", "utf8");
    await symlink(secret, path.join(worktreeDir, OPEN_WIKI_DIR, "link.md"));

    const artifact = await captureArtifact("T0", worktreeDir, artifactsRoot);

    // The symlink is neither a regular file nor a directory to the walker, so it
    // is skipped: capture never reads through a link out of the wiki.
    expect(artifact.documents.map((doc) => doc.relativePath)).toEqual(["a.md"]);
  });
});
