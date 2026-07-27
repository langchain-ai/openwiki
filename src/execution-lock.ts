import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readlink,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { openWikiLocksDir } from "./openwiki-home.js";
import type { OpenWikiCommand, OpenWikiOutputMode } from "./agent/types.js";

export const OPENWIKI_LOCK_EXIT_CODE = 73;
const LOCK_WAIT_DELAY_MS = 50;

export type ExecutionLockScope = {
  command: OpenWikiCommand;
  cwd: string;
  outputMode: OpenWikiOutputMode;
};

export type ExecutionLockDependencies = {
  isProcessAlive?: (pid: number) => boolean;
  locksDir?: string;
  processId?: number;
  sleep?: (delayMs: number) => Promise<void>;
};

export class OpenWikiLockError extends Error {
  readonly exitCode = OPENWIKI_LOCK_EXIT_CODE;

  constructor(message: string) {
    super(message);
    this.name = "OpenWikiLockError";
  }
}

/** Maps lock failures to the portable temporary-failure exit status. */
export function getOpenWikiErrorExitCode(error: unknown): number {
  return error instanceof OpenWikiLockError ? error.exitCode : 1;
}

/**
 * Runs a task while holding its repository/personal lock and, for init runs,
 * the additional shared-home setup lock. Separate code repositories therefore
 * overlap, while a physical repository (including a directory symlink) does
 * not.
 */
export async function withOpenWikiExecutionLock<T>(
  scope: ExecutionLockScope,
  run: () => Promise<T>,
  dependencies: ExecutionLockDependencies = {},
): Promise<T> {
  const lockPaths = await resolveOpenWikiExecutionLockPaths(
    scope,
    dependencies,
  );
  const releases: Array<() => Promise<void>> = [];

  try {
    for (const lockPath of lockPaths) {
      releases.push(await acquirePidSymlinkLock(lockPath, dependencies));
    }

    return await run();
  } finally {
    for (const release of releases.reverse()) {
      await release();
    }
  }
}

export async function resolveOpenWikiExecutionLockPaths(
  scope: ExecutionLockScope,
  dependencies: ExecutionLockDependencies = {},
): Promise<string[]> {
  const locksDir = dependencies.locksDir ?? openWikiLocksDir;
  const targetLock =
    scope.outputMode === "local-wiki"
      ? path.join(locksDir, "personal-wiki.lock")
      : path.join(
          locksDir,
          `code-${createHash("sha256")
            .update(await realpath(scope.cwd))
            .digest("hex")}.lock`,
        );

  return scope.command === "init"
    ? [path.join(locksDir, "home-setup.lock"), targetLock]
    : [targetLock];
}

/** Reusable low-level lock used by bundled-skill synchronization as well. */
export async function withPidSymlinkLock<T>(
  lockPath: string,
  run: () => Promise<T>,
  dependencies: ExecutionLockDependencies = {},
): Promise<T> {
  const release = await acquirePidSymlinkLock(lockPath, dependencies);

  try {
    return await run();
  } finally {
    await release();
  }
}

async function acquirePidSymlinkLock(
  lockPath: string,
  dependencies: ExecutionLockDependencies,
): Promise<() => Promise<void>> {
  const processId = dependencies.processId ?? process.pid;
  const isProcessAlive = dependencies.isProcessAlive ?? defaultIsProcessAlive;
  const sleep = dependencies.sleep ?? defaultSleep;

  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  while (true) {
    try {
      await symlink(String(processId), lockPath);
      return async () => {
        const owner = await readlink(lockPath).catch(() => undefined);

        if (owner === String(processId)) {
          await rm(lockPath, { force: true });
        }
      };
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
    }

    const owner = await readPidSymlinkOwner(lockPath);
    if (owner === null) {
      continue;
    }

    if (!isProcessAlive(owner)) {
      await rm(lockPath, { force: true });
      continue;
    }

    await sleep(LOCK_WAIT_DELAY_MS);
  }
}

async function readPidSymlinkOwner(lockPath: string): Promise<number | null> {
  try {
    const stats = await lstat(lockPath);

    if (!stats.isSymbolicLink()) {
      throw new OpenWikiLockError(
        `OpenWiki lock path is not a PID symlink: ${lockPath}`,
      );
    }
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }

  let owner: string;
  try {
    owner = await readlink(lockPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }

  if (!/^[1-9]\d*$/u.test(owner)) {
    throw new OpenWikiLockError(
      `OpenWiki PID lock has an invalid owner: ${lockPath}`,
    );
  }

  return Number(owner);
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, "ESRCH");
  }
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
