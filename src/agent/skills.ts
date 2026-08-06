import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ensureOpenWikiHome, openWikiSkillsDir } from "../openwiki-home.js";

const bundledSkillsDir = fileURLToPath(
  new URL("../../skills", import.meta.url),
);

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

  await Promise.all(
    skills.map(({ name }) => replaceSkillDirectory(sourceDir, targetDir, name)),
  );
}

/**
 * Installs a single bundled skill by staging it in a unique scratch directory
 * and atomically swapping it into place. Copying straight onto the target is
 * not idempotent: when the destination shows up mid-copy (for example when
 * two syncs overlap during `--init`), `cp`'s internal `mkdir` throws EEXIST
 * (#499). Deleting the old copy in place is racy for the same reason, so the
 * old copy is displaced with an atomic `rename` instead.
 */
async function replaceSkillDirectory(
  sourceDir: string,
  targetDir: string,
  name: string,
): Promise<void> {
  const target = path.join(targetDir, name);
  const scratchDir = await mkdtemp(path.join(targetDir, `.${name}-staging-`));
  const staged = path.join(scratchDir, "staged");
  const displaced = path.join(scratchDir, "displaced");

  try {
    await cp(path.join(sourceDir, name), staged, { recursive: true });

    // Move any existing copy aside; it is deleted with the scratch directory.
    try {
      await rename(target, displaced);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    let installError: Error | undefined;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await rename(staged, target);
        installError = undefined;
        break;
      } catch (error) {
        installError = error as Error;

        // A concurrent sync may have installed the same bundled skill first
        // (rename then fails with EEXIST/ENOTEMPTY on POSIX or EPERM on
        // Windows even though the target is complete), or displaced our
        // fresh install right before this attempt. Accept the former and
        // retry the latter.
        const installed = await stat(target).then(
          (stats) => stats.isDirectory(),
          () => false,
        );

        if (installed) {
          installError = undefined;
          break;
        }
      }
    }

    if (installError !== undefined) {
      throw installError;
    }
  } finally {
    await rm(scratchDir, { force: true, recursive: true });
  }
}
