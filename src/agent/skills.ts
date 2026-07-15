import { cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ensureOpenWikiHome, openWikiSkillsDir } from "../openwiki-home.js";

const bundledSkillsDir = fileURLToPath(
  new URL("../../skills", import.meta.url),
);

/** Copies bundled skills into the OpenWiki home while preserving other skills. */
export async function syncBundledSkills(): Promise<void> {
  await ensureOpenWikiHome();
  await cp(bundledSkillsDir, openWikiSkillsDir, {
    recursive: true,
    force: true,
  });
}
