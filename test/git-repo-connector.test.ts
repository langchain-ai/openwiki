import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// The git-repo connector shells out to `git`, so these tests build real
// throwaway repositories in temp dirs and drive the connector across two runs.
// $HOME points at a throwaway home so the connector reads/writes its config and
// state under `<home>/.openwiki/connectors/git-repo/`, matching production.
//
// The behavior under test: on the second run the manifest must describe what
// was committed *since* the recorded head (issue #409), not just the current
// working-tree diff.

const execFileAsync = promisify(execFile);

const originalHome = process.env.HOME;
const tempDirs: string[] = [];

type GitRepoManifest = {
  changedFiles: string[];
  head: string;
  id: string;
  previousHead?: string;
  recentCommits: string[];
};

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, ["init", "--quiet"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
}

async function commitFile(
  dir: string,
  file: string,
  contents: string,
  message: string,
): Promise<string> {
  await writeFile(path.join(dir, file), contents, "utf8");
  await git(dir, ["add", file]);
  await git(dir, ["commit", "--quiet", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

async function writeGitRepoConfig(
  home: string,
  repos: { id: string; path: string }[],
): Promise<void> {
  const dir = path.join(home, ".openwiki", "connectors", "git-repo");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "config.json"),
    `${JSON.stringify({ repos }, null, 2)}\n`,
    "utf8",
  );
}

async function writeGitRepoState(
  home: string,
  latestIds: Record<string, string>,
): Promise<void> {
  const dir = path.join(home, ".openwiki", "connectors", "git-repo");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "state.json"),
    `${JSON.stringify({ latestIds, version: 1 }, null, 2)}\n`,
    "utf8",
  );
}

async function readManifest(result: {
  rawFiles: string[];
}): Promise<GitRepoManifest[]> {
  const manifestPath = result.rawFiles.find((f) => f.endsWith("manifest.json"));
  expect(manifestPath).toBeDefined();
  const parsed = JSON.parse(await readFile(manifestPath as string, "utf8")) as {
    repos: GitRepoManifest[];
  };
  return parsed.repos;
}

async function loadGitRepoConnector(home: string) {
  vi.resetModules();
  process.env.HOME = home;
  const { createGitRepoConnector } =
    await import("../src/connectors/sources/git-repo.ts");
  return createGitRepoConnector();
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(async () => {
  vi.resetModules();

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("git-repo connector incremental diff", () => {
  test("first run has no previousHead and reports the working-tree diff only", async () => {
    const home = await createTempDir("openwiki-git-home-");
    const repo = await createTempDir("openwiki-git-repo-");
    await initRepo(repo);
    await commitFile(repo, "a.txt", "one\n", "add a");
    // Uncommitted working-tree change.
    await writeFile(path.join(repo, "b.txt"), "dirty\n", "utf8");

    await writeGitRepoConfig(home, [{ id: "demo", path: repo }]);
    const connector = await loadGitRepoConnector(home);

    const result = await connector.ingest();
    const [manifest] = await readManifest(result);

    expect(result.status).toBe("success");
    expect(manifest.previousHead).toBeUndefined();
    // `git diff --name-status HEAD` surfaces the untracked/uncommitted file.
    expect(manifest.changedFiles.join("\n")).not.toContain("a.txt");
  });

  test("second run diffs committed changes since the recorded head", async () => {
    const home = await createTempDir("openwiki-git-home-");
    const repo = await createTempDir("openwiki-git-repo-");
    await initRepo(repo);
    const firstHead = await commitFile(repo, "a.txt", "one\n", "add a");

    await writeGitRepoConfig(home, [{ id: "demo", path: repo }]);

    // First run records `firstHead` in state.
    const first = await connectorRun(home);
    const [firstManifest] = await readManifest(first);
    expect(firstManifest.head).toBe(firstHead);
    expect(firstManifest.previousHead).toBeUndefined();

    // New commit lands between runs.
    const secondHead = await commitFile(repo, "c.txt", "three\n", "add c");

    const second = await connectorRun(home);
    const [secondManifest] = await readManifest(second);

    expect(secondManifest.head).toBe(secondHead);
    expect(secondManifest.previousHead).toBe(firstHead);
    // The diff since the recorded head names the file added in the new commit,
    // not the file from the already-ingested first commit.
    expect(secondManifest.changedFiles.join("\n")).toContain("c.txt");
    expect(secondManifest.changedFiles.join("\n")).not.toContain("a.txt");
    expect(secondManifest.recentCommits.join("\n")).toContain("add c");
    expect(secondManifest.recentCommits.join("\n")).not.toContain("add a");
  });

  test("falls back to working-tree diff when the recorded head is unreachable", async () => {
    const home = await createTempDir("openwiki-git-home-");
    const repo = await createTempDir("openwiki-git-repo-");
    await initRepo(repo);
    const head = await commitFile(repo, "a.txt", "one\n", "add a");

    await writeGitRepoConfig(home, [{ id: "demo", path: repo }]);
    // Seed state with a well-formed SHA that never existed in this repo, as
    // happens after a force-push or a garbage-collected rewrite. A diff against
    // it would throw, so the connector must drop it and fall back.
    await writeGitRepoState(home, {
      demo: "0000000000000000000000000000000000000000",
    });

    const result = await connectorRun(home);
    const [manifest] = await readManifest(result);

    expect(result.status).toBe("success");
    expect(manifest.head).toBe(head);
    expect(manifest.previousHead).toBeUndefined();
  });
});

async function connectorRun(home: string) {
  const connector = await loadGitRepoConnector(home);
  return connector.ingest();
}
