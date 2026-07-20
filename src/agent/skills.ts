import { cp, readdir, rm } from "node:fs/promises";
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

  await Promise.all(
    skills.map(async ({ name }) => {
      const target = path.join(targetDir, name);
      await rm(target, { force: true, recursive: true });
      await cp(path.join(sourceDir, name), target, { recursive: true });
    }),
  );
}
