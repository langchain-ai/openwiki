import {
  readLangSmithRepoConfig,
  writeLangSmithRepoConfig,
} from "./repo-config.js";

/**
 * Project names already configured in the committed repo file. Seeds the setup
 * text field.
 */
export async function listConfiguredLangSmithSources(
  repoRoot: string,
): Promise<string[]> {
  const config = await readLangSmithRepoConfig(repoRoot);
  return (config?.projects ?? []).map((project) => project.name);
}

/**
 * Writes the committed repo file so its projects are exactly `names` (trimmed,
 * deduped, order preserved), keeping other config fields. WYSIWYG: a name removed
 * from the list is removed from the file. A no-op when there is nothing to write
 * and no existing file, so an untouched setup never creates one.
 */
export async function setLangSmithProjects(
  repoRoot: string,
  names: string[],
): Promise<void> {
  const config = await readLangSmithRepoConfig(repoRoot);
  const seen = new Set<string>();
  const projects: { name: string }[] = [];
  for (const name of names) {
    const trimmed = name.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      projects.push({ name: trimmed });
    }
  }
  if (projects.length === 0 && !config) {
    return;
  }
  await writeLangSmithRepoConfig(repoRoot, { ...(config ?? {}), projects });
}
