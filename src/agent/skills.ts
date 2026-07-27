import { cp, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  withPidSymlinkLock,
  type ExecutionLockDependencies,
} from "../execution-lock.js";
import {
  ensureOpenWikiHome,
  openWikiLocksDir,
  openWikiSkillsDir,
} from "../openwiki-home.js";

const bundledSkillsDir = fileURLToPath(
  new URL("../../skills", import.meta.url),
);
const bundledSkillsLockPath = path.join(
  openWikiLocksDir,
  "bundled-skills.lock",
);
const MAX_SKILL_COPY_RETRIES = 3;
const SKILL_COPY_RETRY_DELAY_MS = 25;

type CopyDirectory = (source: string, target: string) => Promise<void>;

export type SkillSyncDependencies = {
  copyDirectory?: CopyDirectory;
  lock?: ExecutionLockDependencies;
  sleep?: (delayMs: number) => Promise<void>;
};

const synchronizeBundledSkills = createBundledSkillsSynchronizer(
  bundledSkillsDir,
  openWikiSkillsDir,
  bundledSkillsLockPath,
);

/** Copies bundled skills into the OpenWiki home while preserving other skills. */
export async function syncBundledSkills(): Promise<void> {
  await ensureOpenWikiHome();
  await synchronizeBundledSkills();
}

/**
 * Builds an in-process queue around a cross-process PID lock. A single Node
 * process cannot wait on its own PID symlink, so both layers are required.
 */
export function createBundledSkillsSynchronizer(
  sourceDir: string,
  targetDir: string,
  lockPath: string,
  dependencies: SkillSyncDependencies = {},
): () => Promise<void> {
  let pending = Promise.resolve();

  return () => {
    const current = pending.then(() =>
      withPidSymlinkLock(
        lockPath,
        () => replaceSkillDirectories(sourceDir, targetDir, dependencies),
        dependencies.lock,
      ),
    );

    // Let the next synchronization proceed after a failed copy rather than
    // permanently poisoning this process's queue.
    pending = current.catch(() => undefined);
    return current;
  };
}

/** Replaces bundled skill directories without removing unrelated skills. */
export async function replaceSkillDirectories(
  sourceDir: string,
  targetDir: string,
  dependencies: Omit<SkillSyncDependencies, "lock"> = {},
): Promise<void> {
  const skills = (await readdir(sourceDir, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory(),
  );

  for (const { name } of skills) {
    const target = path.join(targetDir, name);
    const source = path.join(sourceDir, name);

    for (let attempt = 0; ; attempt += 1) {
      try {
        await rm(target, { force: true, recursive: true });
        await (dependencies.copyDirectory ?? copyDirectory)(source, target);
        break;
      } catch (error) {
        if (
          !isTransientSkillCopyError(error) ||
          attempt >= MAX_SKILL_COPY_RETRIES
        ) {
          throw error;
        }

        await (dependencies.sleep ?? sleep)(
          SKILL_COPY_RETRY_DELAY_MS * 2 ** attempt,
        );
      }
    }
  }
}

export function isTransientSkillCopyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "EEXIST" ||
      (error as NodeJS.ErrnoException).code === "ENOENT")
  );
}

async function copyDirectory(source: string, target: string): Promise<void> {
  await cp(source, target, { recursive: true });
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
