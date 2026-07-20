import { cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ensureOpenWikiHome, openWikiSkillsDir } from "../openwiki-home.js";

const bundledSkillsDir = fileURLToPath(
  new URL("../../skills", import.meta.url),
);
const SKILL_SYNC_LOCK_NAME = ".openwiki-skill-sync.lock";
const SKILL_SYNC_LOCK_RETRY_MS = 25;
const SKILL_SYNC_LOCK_TIMEOUT_MS = 10_000;
const SKILL_SYNC_LOCK_STALE_MS = 5 * 60_000;

/** Copies bundled skills into the OpenWiki home while preserving other skills. */
export async function syncBundledSkills(): Promise<void> {
  await ensureOpenWikiHome();
  await replaceSkillDirectories(bundledSkillsDir, openWikiSkillsDir);
}

/** Replaces bundled skill directories without removing unrelated skills. */
export async function replaceSkillDirectories(
  sourceDir: string,
  targetDir: string,
): Promise<void> {
  const skills = (await readdir(sourceDir, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory(),
  );

  await mkdir(targetDir, { recursive: true });
  await withSkillSyncLock(targetDir, async () => {
    await Promise.all(
      skills.map(async ({ name }) => {
        const target = path.join(targetDir, name);
        await rm(target, { force: true, recursive: true });
        await cp(path.join(sourceDir, name), target, { recursive: true });
      }),
    );
  });
}

/** Serializes bundled-skill replacement across concurrent OpenWiki processes. */
async function withSkillSyncLock(
  targetDir: string,
  operation: () => Promise<void>,
): Promise<void> {
  const lockPath = path.join(targetDir, SKILL_SYNC_LOCK_NAME);
  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }

      if (await removeStaleLock(lockPath)) {
        continue;
      }

      if (Date.now() - startedAt >= SKILL_SYNC_LOCK_TIMEOUT_MS) {
        throw new Error(
          `Timed out waiting for the bundled skill sync lock at ${lockPath}.`,
          { cause: error },
        );
      }

      await delay(SKILL_SYNC_LOCK_RETRY_MS);
    }
  }

  try {
    await operation();
  } finally {
    await rm(lockPath, { force: true, recursive: true });
  }
}

/** Moves an abandoned lock aside before deleting it to avoid path reuse races. */
async function removeStaleLock(lockPath: string): Promise<boolean> {
  let lockStat;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return true;
    }
    throw error;
  }

  if (Date.now() - lockStat.mtimeMs < SKILL_SYNC_LOCK_STALE_MS) {
    return false;
  }

  const abandonedPath = `${lockPath}.stale-${randomUUID()}`;
  try {
    await rename(lockPath, abandonedPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return true;
    }
    throw error;
  }

  await rm(abandonedPath, { force: true, recursive: true });
  return true;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
