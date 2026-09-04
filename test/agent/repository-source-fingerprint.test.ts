import { execFile } from "node:child_process";
import type { BigIntStats, Mode, PathLike } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { OpenWikiIgnore } from "../../src/agent/openwiki-ignore.ts";
import {
  createRepositorySourceFingerprint,
  createRepositorySourceSnapshot,
  getRepositoryChangedPaths,
} from "../../src/agent/utils.ts";

const fingerprintRace = vi.hoisted(() => ({
  replacementPath: null as string | null,
  statIdentityMismatchPath: null as string | null,
  symlinkTarget: null as string | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async open(filePath: PathLike, flags: string | number, mode?: Mode) {
      if (
        typeof filePath === "string" &&
        filePath === fingerprintRace.replacementPath
      ) {
        const symlinkTarget = fingerprintRace.symlinkTarget;
        fingerprintRace.replacementPath = null;
        fingerprintRace.symlinkTarget = null;
        if (!symlinkTarget) {
          throw new Error("Expected a symlink target for the injected race.");
        }
        await actual.rm(filePath);
        await actual.symlink(symlinkTarget, filePath);
      }
      const handle = await actual.open(filePath, flags, mode);
      if (
        typeof filePath === "string" &&
        filePath === fingerprintRace.statIdentityMismatchPath
      ) {
        const originalStat = handle.stat.bind(handle) as (options: {
          bigint: true;
        }) => Promise<BigIntStats>;
        handle.stat = (async () => {
          const stats = await originalStat({ bigint: true });
          stats.dev += 1n;
          stats.ino += 1n;
          return stats;
        }) as typeof handle.stat;
      }
      return handle;
    },
  };
});

const execFileAsync = promisify(execFile);
const ORIGINAL_PLATFORM = process.platform;
let repositoryRoot: string;

/**
 * Runs Git inside an isolated test repository without invoking a shell.
 */
async function git(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return stdout.trim();
}

/**
 * Loads current ignore rules and fingerprints the isolated repository.
 */
async function fingerprint(): Promise<string> {
  return createRepositorySourceFingerprint(
    repositoryRoot,
    await OpenWikiIgnore.load(repositoryRoot),
  );
}

/**
 * Creates one committed repository baseline with safe local Git identity.
 */
async function createRepository(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "openwiki-source-fingerprint-"),
  );
  repositoryRoot = root;
  await git(["init", "--quiet"]);
  await git(["config", "user.email", "openwiki-tests@example.com"]);
  await git(["config", "user.name", "OpenWiki Tests"]);
  await writeFile(
    path.join(root, ".gitignore"),
    [
      ".env",
      ".env.*",
      "*.pem",
      "*.key",
      "*.crt",
      "credentials.json",
      "node_modules/",
      "__pycache__/",
      ".venv/",
      ".DS_Store",
      "",
    ].join("\n"),
    "utf8",
  );
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "tracked.ts"),
    "export const value = 1;\n",
    "utf8",
  );
  await git(["add", "--all"]);
  await git(["commit", "--quiet", "-m", "initial"]);
  return root;
}

function stubPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value,
  });
}

beforeEach(async () => {
  fingerprintRace.replacementPath = null;
  fingerprintRace.statIdentityMismatchPath = null;
  fingerprintRace.symlinkTarget = null;
  await createRepository();
});

afterEach(async () => {
  fingerprintRace.replacementPath = null;
  fingerprintRace.statIdentityMismatchPath = null;
  fingerprintRace.symlinkTarget = null;
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: ORIGINAL_PLATFORM,
  });
  await rm(repositoryRoot, { recursive: true, force: true });
});

describe("createRepositorySourceFingerprint", () => {
  test("returns the fingerprint paired with the HEAD it observed", async () => {
    const snapshot = await createRepositorySourceSnapshot(
      repositoryRoot,
      await OpenWikiIgnore.load(repositoryRoot),
    );

    expect(snapshot).toEqual({
      fingerprint: await fingerprint(),
      gitHead: await git(["rev-parse", "HEAD"]),
    });
  });

  test("is stable for identical source input and changes when HEAD changes", async () => {
    const before = await fingerprint();
    expect(await fingerprint()).toBe(before);

    await git(["commit", "--quiet", "--allow-empty", "-m", "new head"]);

    expect(await fingerprint()).not.toBe(before);
  });

  test("is byte-identical whether scope is omitted, undefined, or a non-subproject scope", async () => {
    // Dirty the tree so status entries (the surface the scope re-bases) also
    // participate in the comparison, not just tracked bytes and HEAD.
    await writeFile(
      path.join(repositoryRoot, "src", "tracked.ts"),
      "export const value = 2;\n",
      "utf8",
    );
    const ignore = await OpenWikiIgnore.load(repositoryRoot);

    const omitted = await createRepositorySourceSnapshot(repositoryRoot, ignore);
    const explicitUndefined = await createRepositorySourceSnapshot(
      repositoryRoot,
      ignore,
      undefined,
    );
    // The root scope is deliberately treated as unscoped for the fingerprint
    // (root stays repo-wide), so it must not perturb the output either.
    const rootScope = await createRepositorySourceSnapshot(
      repositoryRoot,
      ignore,
      { mode: "root-excluding-nested" },
    );

    // The `--show-prefix` prefix is empty at the repository root, so path
    // re-basing is inert and the global HEAD is retained. This guards the new
    // scope parameter against silently changing non-subproject output.
    expect(explicitUndefined).toEqual(omitted);
    expect(rootScope).toEqual(omitted);
    expect(omitted.gitHead).toBe(await git(["rev-parse", "HEAD"]));
  });

  test("distinguishes tracked content and staged from unstaged state", async () => {
    const trackedPath = path.join(repositoryRoot, "src", "tracked.ts");
    const baseline = await fingerprint();

    await writeFile(trackedPath, "export const value = 2;\n", "utf8");
    const unstaged = await fingerprint();
    expect(unstaged).not.toBe(baseline);

    await git(["add", "--", "src/tracked.ts"]);
    const staged = await fingerprint();
    expect(staged).not.toBe(unstaged);

    await writeFile(trackedPath, "export const value = 3;\n", "utf8");
    expect(await fingerprint()).not.toBe(staged);
  });

  test("changes when a tracked source file is deleted", async () => {
    const before = await fingerprint();

    await rm(path.join(repositoryRoot, "src", "tracked.ts"));

    expect(await fingerprint()).not.toBe(before);
  });

  test("changes when a non-ignored untracked file appears", async () => {
    const before = await fingerprint();

    await writeFile(
      path.join(repositoryRoot, "new-source.ts"),
      "export const added = true;\n",
      "utf8",
    );

    expect(await fingerprint()).not.toBe(before);
  });

  test("tracks executable bit changes when the platform exposes them", async () => {
    const trackedPath = path.join(repositoryRoot, "src", "tracked.ts");
    const before = await fingerprint();

    await chmod(trackedPath, 0o755);

    const after = await fingerprint();
    if (process.platform === "win32") {
      expect(after).toBe(before);
    } else {
      expect(after).not.toBe(before);
    }
  });

  test("hashes a symlink target string without following the target", async () => {
    const outside = await mkdtemp(
      path.join(tmpdir(), "openwiki-fingerprint-target-"),
    );
    const firstTarget = path.join(outside, "first.txt");
    const secondTarget = path.join(outside, "second.txt");
    const link = path.join(repositoryRoot, "source-link");

    try {
      await writeFile(firstTarget, "outside one\n", "utf8");
      await writeFile(secondTarget, "outside two\n", "utf8");
      await symlink(firstTarget, link);
      await git(["add", "--", "source-link"]);
      await git(["commit", "--quiet", "-m", "add source symlink"]);
      const before = await fingerprint();

      await writeFile(firstTarget, "outside changed\n", "utf8");
      expect(await fingerprint()).toBe(before);

      await rm(link);
      await symlink(secondTarget, link);
      expect(await fingerprint()).not.toBe(before);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("fails closed when an inspected file becomes a symlink before opening", async () => {
    const outside = await mkdtemp(
      path.join(tmpdir(), "openwiki-fingerprint-race-target-"),
    );
    const outsideTarget = path.join(outside, "outside.txt");

    try {
      await writeFile(outsideTarget, "must not be read\n", "utf8");
      fingerprintRace.replacementPath = path.join(
        repositoryRoot,
        "src",
        "tracked.ts",
      );
      fingerprintRace.symlinkTarget = outsideTarget;

      await expect(fingerprint()).rejects.toThrow(
        /Unable to safely open source path|Source path changed while fingerprinting/u,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("does not reject Windows file handles solely because dev and ino differ", async () => {
    fingerprintRace.statIdentityMismatchPath = path.join(
      repositoryRoot,
      "src",
      "tracked.ts",
    );
    stubPlatform("win32");

    await expect(fingerprint()).resolves.toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  test("changes with .openwikiignore while excluding paths it ignores", async () => {
    const before = await fingerprint();
    await writeFile(
      path.join(repositoryRoot, ".openwikiignore"),
      "ignored-source.txt\n",
      "utf8",
    );
    const withIgnoreRules = await fingerprint();
    expect(withIgnoreRules).not.toBe(before);

    await writeFile(
      path.join(repositoryRoot, "ignored-source.txt"),
      "ignored content\n",
      "utf8",
    );
    expect(await fingerprint()).toBe(withIgnoreRules);
  });

  test("ignores generated pages, Claims sidecars, and run metadata", async () => {
    const claimsDirectory = path.join(repositoryRoot, "openwiki", ".claims");
    await mkdir(claimsDirectory, { recursive: true });

    await writeFile(
      path.join(repositoryRoot, "openwiki", "quickstart.md"),
      "# Generated wiki\n",
      "utf8",
    );
    await writeFile(
      path.join(claimsDirectory, "quickstart.json"),
      '{"claims":[]}\n',
      "utf8",
    );
    await writeFile(
      path.join(repositoryRoot, "openwiki", ".run.json"),
      '{"phase":"generating"}\n',
      "utf8",
    );
    await writeFile(
      path.join(repositoryRoot, "openwiki", ".last-update.json"),
      '{"status":"interrupted"}\n',
      "utf8",
    );

    await git(["add", "--force", "--", "openwiki"]);
    await git(["commit", "--quiet", "-m", "add generated state"]);
    const before = await fingerprint();

    await writeFile(
      path.join(repositoryRoot, "openwiki", "quickstart.md"),
      "# Changed generated wiki\n",
      "utf8",
    );
    await writeFile(
      path.join(claimsDirectory, "quickstart.json"),
      '{"claims":[{"id":"changed"}]}\n',
      "utf8",
    );
    await writeFile(
      path.join(repositoryRoot, "openwiki", ".run.json"),
      '{"phase":"planning"}\n',
      "utf8",
    );
    await writeFile(
      path.join(repositoryRoot, "openwiki", ".last-update.json"),
      '{"status":"complete"}\n',
      "utf8",
    );

    expect(await fingerprint()).toBe(before);
  });

  test("parses unusual tracked filenames from NUL-delimited Git output", async () => {
    const unusualName =
      process.platform === "win32"
        ? "unicode-filename-雪.ts"
        : " leading space\nsecond line\t雪.ts";
    const unusualPath = path.join(repositoryRoot, unusualName);
    await writeFile(unusualPath, "export const unusual = 1;\n", "utf8");
    await git(["add", "--", unusualName]);
    await git(["commit", "--quiet", "-m", "add unusual filename"]);
    const before = await fingerprint();

    await writeFile(unusualPath, "export const unusual = 2;\n", "utf8");

    expect(await fingerprint()).not.toBe(before);
  });

  test("rejects a relative repository root", async () => {
    await expect(
      createRepositorySourceFingerprint(
        ".",
        await OpenWikiIgnore.load(repositoryRoot),
      ),
    ).rejects.toThrow("requires an absolute root");
  });
});

describe("getRepositoryChangedPaths", () => {
  test("returns visible committed, tracked, and untracked planner context", async () => {
    const baseGitHead = await git(["rev-parse", "HEAD"]);
    await writeFile(
      path.join(repositoryRoot, "committed.ts"),
      "export const committed = true;\n",
      "utf8",
    );
    await git(["add", "--", "committed.ts"]);
    await git(["commit", "--quiet", "-m", "add committed source"]);

    await writeFile(
      path.join(repositoryRoot, "src", "tracked.ts"),
      "export const value = 2;\n",
      "utf8",
    );
    await writeFile(
      path.join(repositoryRoot, ".openwikiignore"),
      "ignored.txt\n",
      "utf8",
    );
    await writeFile(
      path.join(repositoryRoot, "ignored.txt"),
      "ignored\n",
      "utf8",
    );
    await writeFile(
      path.join(repositoryRoot, "visible.txt"),
      "visible\n",
      "utf8",
    );
    await mkdir(path.join(repositoryRoot, "openwiki"), { recursive: true });
    await writeFile(
      path.join(repositoryRoot, "openwiki", "generated.md"),
      "generated\n",
      "utf8",
    );

    const changed = await getRepositoryChangedPaths(
      repositoryRoot,
      await OpenWikiIgnore.load(repositoryRoot),
      baseGitHead,
    );

    expect(changed).toEqual([
      ".openwikiignore",
      "committed.ts",
      "src/tracked.ts",
      "visible.txt",
    ]);
  });
});

describe("createRepositorySourceSnapshot subproject scope", () => {
  const subprojectRepos: string[] = [];

  async function gitAt(cwd: string, args: readonly string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
    });
    return stdout.trim();
  }

  /**
   * Builds a two-subproject monorepo (`packages/foo`, `packages/bar`), each with
   * its own `src/` and committed `openwiki/` output, on one committed baseline.
   */
  async function createMonorepo(): Promise<{ repo: string; fooDir: string }> {
    const repo = await mkdtemp(
      path.join(tmpdir(), "openwiki-fingerprint-scope-"),
    );
    subprojectRepos.push(repo);
    await gitAt(repo, ["init", "--quiet"]);
    await gitAt(repo, ["config", "user.email", "openwiki-tests@example.com"]);
    await gitAt(repo, ["config", "user.name", "OpenWiki Tests"]);
    for (const pkg of ["foo", "bar"]) {
      await mkdir(path.join(repo, "packages", pkg, "src"), { recursive: true });
      await mkdir(path.join(repo, "packages", pkg, "openwiki"), {
        recursive: true,
      });
      await writeFile(
        path.join(repo, "packages", pkg, "src", "code.ts"),
        `export const ${pkg} = 1;\n`,
        "utf8",
      );
      await writeFile(
        path.join(repo, "packages", pkg, "openwiki", "quickstart.md"),
        `# ${pkg}\n`,
        "utf8",
      );
    }
    await gitAt(repo, ["add", "--all"]);
    await gitAt(repo, ["commit", "--quiet", "-m", "initial"]);
    return { repo, fooDir: path.join(repo, "packages", "foo") };
  }

  async function scopedFingerprint(dir: string): Promise<string> {
    return createRepositorySourceFingerprint(dir, await OpenWikiIgnore.load(dir), {
      mode: "subproject",
    });
  }

  afterEach(async () => {
    await Promise.all(
      subprojectRepos
        .splice(0)
        .map((repo) => rm(repo, { recursive: true, force: true })),
    );
  });

  test("stays stable when a sibling subproject commits", async () => {
    const { repo, fooDir } = await createMonorepo();
    const before = await scopedFingerprint(fooDir);

    await writeFile(
      path.join(repo, "packages", "bar", "src", "code.ts"),
      "export const bar = 2;\n",
      "utf8",
    );
    await gitAt(repo, ["add", "--all"]);
    await gitAt(repo, ["commit", "--quiet", "-m", "sibling commit"]);

    expect(await scopedFingerprint(fooDir)).toBe(before);
  });

  test("stays stable when a sibling subproject is dirty in the worktree", async () => {
    const { repo, fooDir } = await createMonorepo();
    const before = await scopedFingerprint(fooDir);

    await writeFile(
      path.join(repo, "packages", "bar", "src", "code.ts"),
      "export const bar = 3;\n",
      "utf8",
    );

    expect(await scopedFingerprint(fooDir)).toBe(before);
  });

  test("excludes the subproject's own dirty openwiki output (namespace normalization fixes self-churn)", async () => {
    const { fooDir } = await createMonorepo();
    const ignore = await OpenWikiIgnore.load(fooDir);
    const scopedBefore = await createRepositorySourceFingerprint(fooDir, ignore, {
      mode: "subproject",
    });
    const unscopedBefore = await createRepositorySourceFingerprint(
      fooDir,
      ignore,
    );

    // Simulate the update rewriting its own generated wiki without committing —
    // exactly the mid-run state hasRepositorySourceChanged inspects.
    await writeFile(
      path.join(fooDir, "openwiki", "quickstart.md"),
      "# foo regenerated\n",
      "utf8",
    );

    // Scoped: `git status` reports `packages/foo/openwiki/quickstart.md`, which
    // is re-based to `openwiki/quickstart.md` and excluded, so the fingerprint
    // is stable (no false self-churn forcing the interrupted branch).
    expect(
      await createRepositorySourceFingerprint(fooDir, ignore, {
        mode: "subproject",
      }),
    ).toBe(scopedBefore);

    // Contrast — the pre-fix repo-wide namespace: the unscoped status path
    // `packages/foo/openwiki/quickstart.md` is NOT matched by isOpenWikiPath, so
    // the unscoped fingerprint DOES flip. This is the defect the fix removes.
    expect(await createRepositorySourceFingerprint(fooDir, ignore)).not.toBe(
      unscopedBefore,
    );
  });

  test("changes when the subproject's own source changes", async () => {
    const { fooDir } = await createMonorepo();
    const before = await scopedFingerprint(fooDir);

    await writeFile(
      path.join(fooDir, "src", "code.ts"),
      "export const foo = 2;\n",
      "utf8",
    );

    expect(await scopedFingerprint(fooDir)).not.toBe(before);
  });

  test("returns gitHead equal to the subtree's last-touching commit, not the global HEAD", async () => {
    const { repo, fooDir } = await createMonorepo();
    const fooHeadAtInit = await gitAt(fooDir, [
      "log",
      "-1",
      "--format=%H",
      "--",
      ".",
    ]);

    // Advance the global HEAD with a sibling-only commit so it diverges from
    // foo's last-touching commit. Without the fix, gitHead would be the global
    // HEAD; the fix must pin it to the subtree commit.
    await writeFile(
      path.join(repo, "packages", "bar", "src", "code.ts"),
      "export const bar = 2;\n",
      "utf8",
    );
    await gitAt(repo, ["add", "--all"]);
    await gitAt(repo, ["commit", "--quiet", "-m", "sibling commit"]);
    const globalHead = await gitAt(repo, ["rev-parse", "HEAD"]);
    expect(globalHead).not.toBe(fooHeadAtInit); // sanity: HEAD advanced

    const snapshot = await createRepositorySourceSnapshot(
      fooDir,
      await OpenWikiIgnore.load(fooDir),
      { mode: "subproject" },
    );

    expect(snapshot.gitHead).toBe(fooHeadAtInit);
    expect(snapshot.gitHead).not.toBe(globalHead);
  });

  test("the returned gitHead is a valid subtree-scoped diff base", async () => {
    const { repo, fooDir } = await createMonorepo();
    const ignore = await OpenWikiIgnore.load(fooDir);
    const snapshot = await createRepositorySourceSnapshot(fooDir, ignore, {
      mode: "subproject",
    });
    if (!snapshot.gitHead) {
      throw new Error("Expected a subtree gitHead baseline.");
    }
    const baseline = snapshot.gitHead;

    // A sibling commit advances the shared HEAD but not this subtree baseline, so
    // a subtree-scoped diff from it is empty — the page fast-forward's precise
    // "nothing changed under me" predicate.
    await writeFile(
      path.join(repo, "packages", "bar", "src", "code.ts"),
      "export const bar = 2;\n",
      "utf8",
    );
    await gitAt(repo, ["add", "--all"]);
    await gitAt(repo, ["commit", "--quiet", "-m", "sibling commit"]);
    await expect(
      getRepositoryChangedPaths(fooDir, ignore, baseline, {
        mode: "subproject",
      }),
    ).resolves.toEqual([]);

    // The subproject's own commit does surface in that same diff, so it is not
    // fast-forwarded.
    await writeFile(
      path.join(fooDir, "src", "code.ts"),
      "export const foo = 2;\n",
      "utf8",
    );
    await gitAt(repo, ["add", "--all"]);
    await gitAt(repo, ["commit", "--quiet", "-m", "own commit"]);
    await expect(
      getRepositoryChangedPaths(fooDir, ignore, baseline, {
        mode: "subproject",
      }),
    ).resolves.toContain("src/code.ts");
  });

  test("a global (non-subtree) commit stays a valid subtree-scoped diff base across sibling commits (migration)", async () => {
    const { repo, fooDir } = await createMonorepo();
    const ignore = await OpenWikiIgnore.load(fooDir);
    // The initial commit is the shared baseline a pre-fix run (or `.last-update`
    // seeding) stamps as a GLOBAL head — the mixed state on the first update
    // after upgrading, where entry.gitHead is global, not foo's subtree head.
    const globalBaseline = await gitAt(repo, ["rev-parse", "HEAD"]);

    // Several sibling-only commits advance the global HEAD far past the subtree.
    for (const value of [2, 3, 4]) {
      await writeFile(
        path.join(repo, "packages", "bar", "src", "code.ts"),
        `export const bar = ${value};\n`,
        "utf8",
      );
      await gitAt(repo, ["add", "--all"]);
      await gitAt(repo, ["commit", "--quiet", "-m", `sibling ${value}`]);
    }

    // foo is unchanged, so the scoped diff from the OLD GLOBAL baseline is empty
    // — fast-forward migrates the entry to the subtree head without regenerating.
    await expect(
      getRepositoryChangedPaths(fooDir, ignore, globalBaseline, {
        mode: "subproject",
      }),
    ).resolves.toEqual([]);

    // Once foo itself changes, the same global-baseline scoped diff surfaces only
    // foo's path and never a sibling's.
    await writeFile(
      path.join(fooDir, "src", "code.ts"),
      "export const foo = 2;\n",
      "utf8",
    );
    await gitAt(repo, ["add", "--all"]);
    await gitAt(repo, ["commit", "--quiet", "-m", "own change"]);
    const changed = await getRepositoryChangedPaths(
      fooDir,
      ignore,
      globalBaseline,
      { mode: "subproject" },
    );
    expect(changed).toContain("src/code.ts");
    expect(changed.some((candidate) => candidate.includes("bar"))).toBe(false);
  });

  test("omits gitHead when no commit has touched the subtree yet", async () => {
    const { repo } = await createMonorepo();
    const bazDir = path.join(repo, "packages", "baz");
    await mkdir(path.join(bazDir, "src"), { recursive: true });
    await writeFile(
      path.join(bazDir, "src", "code.ts"),
      "export const baz = 1;\n",
      "utf8",
    );

    const snapshot = await createRepositorySourceSnapshot(
      bazDir,
      await OpenWikiIgnore.load(bazDir),
      { mode: "subproject" },
    );

    expect(snapshot.gitHead).toBeUndefined();
    expect(snapshot.fingerprint).toMatch(/^sha256:/u);
  });

  test("omits gitHead on an unborn branch (subproject scope) without throwing", async () => {
    const repo = await mkdtemp(
      path.join(tmpdir(), "openwiki-fingerprint-scope-"),
    );
    subprojectRepos.push(repo);
    await gitAt(repo, ["init", "--quiet"]);
    await gitAt(repo, ["config", "user.email", "openwiki-tests@example.com"]);
    await gitAt(repo, ["config", "user.name", "OpenWiki Tests"]);
    const pkgDir = path.join(repo, "packages", "foo");
    await mkdir(path.join(pkgDir, "src"), { recursive: true });
    await writeFile(
      path.join(pkgDir, "src", "code.ts"),
      "export const foo = 1;\n",
      "utf8",
    );

    // No commit exists at all — the branch is unborn, so `git log -1 -- .`
    // throws. The hardened resolver confirms HEAD does not resolve before
    // returning the sentinel, so this must omit gitHead rather than throw.
    const snapshot = await createRepositorySourceSnapshot(
      pkgDir,
      await OpenWikiIgnore.load(pkgDir),
      { mode: "subproject" },
    );

    expect(snapshot.gitHead).toBeUndefined();
    expect(snapshot.fingerprint).toMatch(/^sha256:/u);
  });
});
