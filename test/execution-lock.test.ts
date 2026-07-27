import {
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  getOpenWikiErrorExitCode,
  OpenWikiLockError,
  resolveOpenWikiExecutionLockPaths,
  withOpenWikiExecutionLock,
  type ExecutionLockDependencies,
  type ExecutionLockScope,
} from "../src/execution-lock.ts";

test("maps malformed lock failures to exit 73", () => {
  expect(getOpenWikiErrorExitCode(new OpenWikiLockError("bad lock"))).toBe(73);
  expect(getOpenWikiErrorExitCode(new Error("other error"))).toBe(1);
});

function repositoryScope(
  cwd: string,
  command: "chat" | "init" | "update" = "chat",
): ExecutionLockScope {
  return { command, cwd, outputMode: "repository" };
}

function personalScope(cwd: string): ExecutionLockScope {
  return { command: "chat", cwd, outputMode: "local-wiki" };
}

function createDependencies(locksDir: string): ExecutionLockDependencies {
  return {
    locksDir,
    sleep: (delayMs) =>
      new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 1))),
  };
}

async function waitFor(
  assertion: () => void,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

describe("withOpenWikiExecutionLock", () => {
  test("allows separate repositories to enter together", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-lock-"));
    const locksDir = path.join(root, "locks");
    const repoA = path.join(root, "repo-a");
    const repoB = path.join(root, "repo-b");
    const events: string[] = [];
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      await Promise.all([mkdir(repoA), mkdir(repoB)]);
      const dependencies = createDependencies(locksDir);
      const first = withOpenWikiExecutionLock(
        repositoryScope(repoA),
        async () => {
          events.push("a:start");
          await held;
          events.push("a:end");
        },
        dependencies,
      );
      const second = withOpenWikiExecutionLock(
        repositoryScope(repoB),
        async () => {
          events.push("b:start");
          await held;
          events.push("b:end");
        },
        dependencies,
      );

      await waitFor(() => expect(events).toContain("a:start"));
      await waitFor(() => expect(events).toContain("b:start"));
      expect(events.slice(0, 2)).toEqual(
        expect.arrayContaining(["a:start", "b:start"]),
      );
      release?.();
      await Promise.all([first, second]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("serializes a physical repository across symlinked paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-lock-"));
    const locksDir = path.join(root, "locks");
    const repo = path.join(root, "repo");
    const alias = path.join(root, "repo-alias");
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    try {
      await mkdir(repo);
      await symlink(repo, alias, "dir");
      const dependencies = createDependencies(locksDir);
      const first = withOpenWikiExecutionLock(
        repositoryScope(repo),
        async () => {
          events.push("first:start");
          await firstHeld;
          events.push("first:end");
        },
        dependencies,
      );
      await waitFor(() => expect(events).toEqual(["first:start"]));

      const second = withOpenWikiExecutionLock(
        repositoryScope(alias),
        () => {
          events.push("second:start");
          events.push("second:end");
          return Promise.resolve();
        },
        dependencies,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(events).toEqual(["first:start"]);

      releaseFirst?.();
      await Promise.all([first, second]);
      expect(events).toEqual([
        "first:start",
        "first:end",
        "second:start",
        "second:end",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("serializes personal runs while an unrelated repository can run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-lock-"));
    const locksDir = path.join(root, "locks");
    const repo = path.join(root, "repo");
    const events: string[] = [];
    let releasePersonal: (() => void) | undefined;
    const personalHeld = new Promise<void>((resolve) => {
      releasePersonal = resolve;
    });

    try {
      await mkdir(repo);
      const dependencies = createDependencies(locksDir);
      const first = withOpenWikiExecutionLock(
        personalScope(repo),
        async () => {
          events.push("personal:first:start");
          await personalHeld;
          events.push("personal:first:end");
        },
        dependencies,
      );
      await waitFor(() => expect(events).toEqual(["personal:first:start"]));

      const second = withOpenWikiExecutionLock(
        personalScope(repo),
        () => {
          events.push("personal:second:start");
          return Promise.resolve();
        },
        dependencies,
      );
      const repository = withOpenWikiExecutionLock(
        repositoryScope(repo),
        () => {
          events.push("repository:start");
          return Promise.resolve();
        },
        dependencies,
      );
      await waitFor(() => expect(events).toContain("repository:start"));
      expect(events).not.toContain("personal:second:start");

      releasePersonal?.();
      await Promise.all([first, second, repository]);
      expect(events.indexOf("personal:second:start")).toBeGreaterThan(
        events.indexOf("personal:first:end"),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("serializes init shared-home setup without blocking another normal repository", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-lock-"));
    const locksDir = path.join(root, "locks");
    const repoA = path.join(root, "repo-a");
    const repoB = path.join(root, "repo-b");
    const repoC = path.join(root, "repo-c");
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    try {
      await Promise.all([mkdir(repoA), mkdir(repoB), mkdir(repoC)]);
      const dependencies = createDependencies(locksDir);
      const firstInit = withOpenWikiExecutionLock(
        repositoryScope(repoA, "init"),
        async () => {
          events.push("init:first:start");
          await firstHeld;
          events.push("init:first:end");
        },
        dependencies,
      );
      await waitFor(() => expect(events).toEqual(["init:first:start"]));

      const normal = withOpenWikiExecutionLock(
        repositoryScope(repoB),
        () => {
          events.push("normal:start");
          return Promise.resolve();
        },
        dependencies,
      );
      const secondInit = withOpenWikiExecutionLock(
        repositoryScope(repoC, "init"),
        () => {
          events.push("init:second:start");
          return Promise.resolve();
        },
        dependencies,
      );
      await waitFor(() => expect(events).toContain("normal:start"));
      expect(events).not.toContain("init:second:start");

      releaseFirst?.();
      await Promise.all([firstInit, normal, secondInit]);
      expect(events.indexOf("init:second:start")).toBeGreaterThan(
        events.indexOf("init:first:end"),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("recovers a dead PID symlink and rejects malformed or regular-file locks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-lock-"));
    const locksDir = path.join(root, "locks");
    const repo = path.join(root, "repo");
    const dependencies: ExecutionLockDependencies = {
      ...createDependencies(locksDir),
      isProcessAlive: () => false,
    };

    try {
      await mkdir(repo);
      const [lockPath] = await resolveOpenWikiExecutionLockPaths(
        repositoryScope(repo),
        dependencies,
      );
      await mkdir(path.dirname(lockPath), { recursive: true });
      await symlink("99999999", lockPath);

      await expect(
        withOpenWikiExecutionLock(
          repositoryScope(repo),
          () => Promise.resolve(undefined),
          dependencies,
        ),
      ).resolves.toBeUndefined();
      await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });

      await writeFile(lockPath, "not a symlink");
      await expect(
        withOpenWikiExecutionLock(
          repositoryScope(repo),
          () => Promise.resolve(undefined),
          dependencies,
        ),
      ).rejects.toMatchObject({ exitCode: 73 });

      await rm(lockPath);
      await symlink("not-a-pid", lockPath);
      await expect(
        withOpenWikiExecutionLock(
          repositoryScope(repo),
          () => Promise.resolve(undefined),
          dependencies,
        ),
      ).rejects.toBeInstanceOf(OpenWikiLockError);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
