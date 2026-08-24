import { execFile } from "node:child_process";
import type { Mode, PathLike } from "node:fs";
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
  getRepositoryChangedPaths,
} from "../../src/agent/utils.ts";

const fingerprintRace = vi.hoisted(() => ({
  replacementPath: null as string | null,
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
      return actual.open(filePath, flags, mode);
    },
  };
});

const execFileAsync = promisify(execFile);
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

beforeEach(async () => {
  fingerprintRace.replacementPath = null;
  fingerprintRace.symlinkTarget = null;
  await createRepository();
});

afterEach(async () => {
  fingerprintRace.replacementPath = null;
  fingerprintRace.symlinkTarget = null;
  await rm(repositoryRoot, { recursive: true, force: true });
});

describe("createRepositorySourceFingerprint", () => {
  test("is stable for identical source input and changes when HEAD changes", async () => {
    const before = await fingerprint();
    expect(await fingerprint()).toBe(before);

    await git(["commit", "--quiet", "--allow-empty", "-m", "new head"]);

    expect(await fingerprint()).not.toBe(before);
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

  test("changes when a source file executable bit changes", async () => {
    const trackedPath = path.join(repositoryRoot, "src", "tracked.ts");
    const before = await fingerprint();

    await chmod(trackedPath, 0o755);

    expect(await fingerprint()).not.toBe(before);
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
    const unusualName = " leading space\nsecond line\t雪.ts";
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
