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
  changedFilesTruncated?: boolean;
  recentCommits: string[];
  recentCommitsTruncated?: boolean;
  status: string;
  statusTruncated?: boolean;
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

describe("git-repo connector oversized git output", () => {
  test("advances the recorded head and bounds the manifest when a range prints over 1 MiB", async () => {
    const home = await createTempDir("openwiki-git-home-");
    const repoPath = await initRepo("huge-range");
    await writeGitRepoConfig(home, {
      repos: [{ id: "huge-repo", path: repoPath }],
    });
    const connector = await loadGitRepoConnector(home);

    const first = await connector.ingest();
    expect(first.status).toBe("success");

    // One commit adding 30,000 files makes both the `log` and `diff` output
    // for previousHead..HEAD larger than 1 MiB. fast-import keeps it quick.
    const branch = await runGit(repoPath, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    const parent = await runGit(repoPath, ["rev-parse", "HEAD"]);
    const NL = String.fromCharCode(10);
    const lines = [
      "blob",
      "mark :1",
      "data 0",
      "",
      `commit refs/heads/${branch}`,
      "committer t <t@t.dev> 1700000000 +0000",
      "data 3",
      "big",
      `from ${parent}`,
    ];
    for (let index = 0; index < 30000; index += 1) {
      lines.push(
        `M 100644 :1 vendor/some-package-name/src/module-file-${index}.js`,
      );
    }
    const input = lines.join(NL) + NL;
    const fastImport = execFileAsync("git", ["fast-import", "--quiet"], {
      cwd: repoPath,
    });
    fastImport.child.stdin?.end(input);
    await fastImport;
    const head = await runGit(repoPath, ["rev-parse", "HEAD"]);
    expect(head).not.toBe(parent);

    const second = await connector.ingest();

    expect(second.warnings).toEqual([]);
    expect(second.status).toBe("success");

    const manifest = (await readManifest(second.rawFiles[0] ?? "")).repos[0];
    expect(manifest.head).toBe(head);
    expect(manifest.changedFiles.length).toBeGreaterThan(0);
    expect(manifest.changedFiles.length).toBeLessThan(30000);
    expect(manifest.recentCommits.length).toBeLessThan(30000);
    expect(manifest.changedFilesTruncated).toBe(true);
    expect(manifest.recentCommitsTruncated).toBe(true);

    // The recorded head moved, so the next run diffs from the new head
    // instead of re-failing on the same growing range.
    const state = JSON.parse(
      await readFile(
        path.join(home, ".openwiki", "connectors", "git-repo", "state.json"),
        "utf8",
      ),
    ) as { latestIds?: Record<string, string> };
    expect(state.latestIds?.["huge-repo"]).toBe(head);
  });

  test("bounds the manifest by bytes when commit subjects are enormous", async () => {
    const home = await createTempDir("openwiki-git-home-");
    const repoPath = await initRepo("huge-subject");
    await writeGitRepoConfig(home, {
      repos: [{ id: "subject-repo", path: repoPath }],
    });
    const connector = await loadGitRepoConnector(home);
    expect((await connector.ingest()).status).toBe("success");

    // Three commits with 2 MB single-line subjects: few lines, many bytes.
    const branch = await runGit(repoPath, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    let parent = await runGit(repoPath, ["rev-parse", "HEAD"]);
    const subject = "x".repeat(2 * 1024 * 1024);
    const NL = String.fromCharCode(10);
    const lines: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      lines.push(
        `commit refs/heads/${branch}`,
        `mark :${index + 1}`,
        "committer t <t@t.dev> 1700000000 +0000",
        `data ${subject.length + 1}`,
        subject,
        `from ${parent}`,
        `M 100644 inline file-${index}.txt`,
        "data 1",
        "a",
        "",
      );
      parent = `:${index + 1}`;
    }
    const input = lines.join(NL) + NL;
    const fastImport = execFileAsync("git", ["fast-import", "--quiet"], {
      cwd: repoPath,
      maxBuffer: 64 * 1024 * 1024,
    });
    fastImport.child.stdin?.end(input);
    await fastImport;
    const head = await runGit(repoPath, ["rev-parse", "HEAD"]);

    const second = await connector.ingest();

    expect(second.warnings).toEqual([]);
    expect(second.status).toBe("success");
    const manifest = (await readManifest(second.rawFiles[0] ?? "")).repos[0];
    expect(manifest.head).toBe(head);
    expect(manifest.recentCommitsTruncated).toBe(true);
    const bytes = Buffer.byteLength(manifest.recentCommits.join(NL), "utf8");
    expect(bytes).toBeLessThan(256 * 1024);
  });
});
