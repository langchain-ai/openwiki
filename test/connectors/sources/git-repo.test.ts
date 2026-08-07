import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";

const execFileAsync = promisify(execFile);

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempDirs: string[] = [];

type GitRepoManifest = {
  branch: string;
  changedFiles: string[];
  head: string;
  id: string;
  path: string;
  recentCommits: string[];
  status: string;
};

type ManifestDump = {
  generatedAt: string;
  repos: GitRepoManifest[];
};

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

/**
 * Creates a real git repo on `main` with a single committed file so the
 * connector has a genuine history, branch, and HEAD to read.
 */
async function initRepo(name: string): Promise<string> {
  const repoPath = await createTempDir(`openwiki-git-src-${name}-`);
  await runGit(repoPath, ["-c", "init.defaultBranch=main", "init"]);
  await writeFile(path.join(repoPath, "README.md"), "hello\n", "utf8");
  await runGit(repoPath, ["add", "README.md"]);
  await runGit(repoPath, [
    "-c",
    "user.email=test@openwiki.dev",
    "-c",
    "user.name=OpenWiki Test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "initial commit",
  ]);
  return repoPath;
}

async function writeGitRepoConfig(
  home: string,
  config: unknown,
): Promise<void> {
  const dir = path.join(home, ".openwiki", "connectors", "git-repo");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

async function loadGitRepoConnector(home: string) {
  vi.resetModules();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const { createGitRepoConnector } =
    await import("../../../src/connectors/sources/git-repo.ts");
  return createGitRepoConnector();
}

async function readManifest(rawFile: string): Promise<ManifestDump> {
  return JSON.parse(await readFile(rawFile, "utf8")) as ManifestDump;
}

afterEach(async () => {
  vi.resetModules();

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }

  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("git-repo connector configuration", () => {
  test("skips with guidance when no repositories are configured", async () => {
    const home = await createTempDir("openwiki-git-home-");
    const connector = await loadGitRepoConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("skipped");
    expect(result.message).toContain(
      "~/.openwiki/connectors/git-repo/config.json",
    );
    expect(result.warnings).toEqual([]);
  });

  test("warns and skips a repo whose id is unsafe", async () => {
    const home = await createTempDir("openwiki-git-home-");
    const repoPath = await initRepo("unsafe");
    await writeGitRepoConfig(home, {
      repos: [{ id: "../escape", path: repoPath }],
    });
    const connector = await loadGitRepoConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("skipped");
    expect(result.warnings).toEqual(["Skipped repo with unsafe id: ../escape"]);

    const dump = await readManifest(result.rawFiles[0] ?? "");
    expect(dump.repos).toEqual([]);
  });
});

describe("git-repo connector manifest building", () => {
  test("captures branch, head, recent commits, and clean status", async () => {
    const home = await createTempDir("openwiki-git-home-");
    const repoPath = await initRepo("clean");
    await writeGitRepoConfig(home, {
      repos: [{ id: "clean-repo", path: repoPath }],
    });
    const connector = await loadGitRepoConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(result.warnings).toEqual([]);

    const dump = await readManifest(result.rawFiles[0] ?? "");
    expect(dump.repos).toHaveLength(1);
    const manifest = dump.repos[0];
    expect(manifest.id).toBe("clean-repo");
    expect(manifest.path).toBe(path.resolve(repoPath));
    expect(manifest.branch).toBe("main");
    expect(manifest.head).toBe(await runGit(repoPath, ["rev-parse", "HEAD"]));
    expect(manifest.head).toMatch(/^[0-9a-f]{40}$/u);
    expect(manifest.recentCommits.join("\n")).toContain("initial commit");
    // A committed, otherwise-untouched repo has an empty working tree.
    expect(manifest.status).toBe("");
    expect(manifest.changedFiles).toEqual([]);
  });

  test("reports uncommitted working-tree changes", async () => {
    const home = await createTempDir("openwiki-git-home-");
    const repoPath = await initRepo("dirty");
    await writeFile(path.join(repoPath, "README.md"), "hello again\n", "utf8");
    await writeGitRepoConfig(home, {
      repos: [{ id: "dirty-repo", path: repoPath }],
    });
    const connector = await loadGitRepoConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    const dump = await readManifest(result.rawFiles[0] ?? "");
    const manifest = dump.repos[0];
    expect(manifest.status).toContain("README.md");
    expect(manifest.changedFiles).toEqual(["M\tREADME.md"]);
  });

  test("records a per-repo warning when the path is not a git repo", async () => {
    const home = await createTempDir("openwiki-git-home-");
    const notARepo = await createTempDir("openwiki-git-plain-");
    await writeGitRepoConfig(home, {
      repos: [{ id: "missing", path: notARepo }],
    });
    const connector = await loadGitRepoConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("skipped");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("missing: ");

    const dump = await readManifest(result.rawFiles[0] ?? "");
    expect(dump.repos).toEqual([]);
  });

  test("honors the limit option and ingests only the first repos", async () => {
    const home = await createTempDir("openwiki-git-home-");
    const first = await initRepo("first");
    const second = await initRepo("second");
    await writeGitRepoConfig(home, {
      repos: [
        { id: "first-repo", path: first },
        { id: "second-repo", path: second },
      ],
    });
    const connector = await loadGitRepoConnector(home);

    const result = await connector.ingest({ limit: 1 });

    expect(result.status).toBe("success");
    const dump = await readManifest(result.rawFiles[0] ?? "");
    expect(dump.repos.map((repo) => repo.id)).toEqual(["first-repo"]);
  });
});
