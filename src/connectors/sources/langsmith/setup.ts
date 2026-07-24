import type { LangSmithWorkspaceConfig } from "./repo-config.js";
import {
  readLangSmithRepoConfig,
  writeLangSmithRepoConfig,
} from "./repo-config.js";

/**
 * LangSmith workspace region. Maps to the two official API hosts the connector
 * is allowlisted to talk to; the wizard offers this instead of a raw URL.
 */
export type LangSmithRegion = "us" | "eu";

/**
 * EU host, written to apiBaseUrl for EU workspaces. The US host is the connector
 * default, so it is left out of the file entirely.
 */
const EU_API_BASE_URL = "https://eu.api.smith.langchain.com";

/**
 * Base env var name for the first workspace's key. Additional workspaces get
 * OPENWIKI_LANGSMITH_API_KEY_<n>.
 */
const PRIMARY_API_KEY_ENV = "OPENWIKI_LANGSMITH_API_KEY";

/**
 * One workspace as the wizard edits it: a region, the env var naming its key, and
 * the project names.
 */
export interface LangSmithWorkspaceSetup {
  /**
   * Workspace region derived from the committed apiBaseUrl (US when unset).
   */
  region: LangSmithRegion;

  /**
   * Env var name holding this workspace's API key.
   */
  apiKeyEnv: string;

  /**
   * Configured project names, in file order.
   */
  projects: string[];
}

/**
 * Reads the committed workspaces so the wizard can seed its fields. Returns an
 * empty list when the repo has no config.
 */
export async function loadLangSmithSetup(
  repoRoot: string,
): Promise<LangSmithWorkspaceSetup[]> {
  const config = await readLangSmithRepoConfig(repoRoot);
  return (config?.workspaces ?? []).map((workspace) => ({
    apiKeyEnv: workspace.apiKeyEnv,
    projects: workspace.projects.map((project) => project.name),
    region: workspace.apiBaseUrl === EU_API_BASE_URL ? "eu" : "us",
  }));
}

/**
 * Writes the committed config so its workspaces are exactly `workspaces` (project
 * names trimmed, deduped, order preserved; region -> apiBaseUrl). WYSIWYG: a
 * workspace with no projects is dropped (which also removes it), and switching a
 * workspace back to US drops its apiBaseUrl. A no-op when there is nothing to
 * write and no existing file, so an untouched setup never creates one.
 */
export async function saveLangSmithSetup(
  repoRoot: string,
  workspaces: LangSmithWorkspaceSetup[],
): Promise<void> {
  const existing = await readLangSmithRepoConfig(repoRoot);
  const cleaned: LangSmithWorkspaceConfig[] = [];
  for (const workspace of workspaces) {
    const seen = new Set<string>();
    const projects: { name: string }[] = [];
    for (const name of workspace.projects) {
      const trimmed = name.trim();
      if (trimmed.length > 0 && !seen.has(trimmed)) {
        seen.add(trimmed);
        projects.push({ name: trimmed });
      }
    }
    if (projects.length === 0) {
      continue;
    }
    cleaned.push({
      apiKeyEnv: workspace.apiKeyEnv,
      projects,
      ...(workspace.region === "eu" ? { apiBaseUrl: EU_API_BASE_URL } : {}),
    });
  }
  if (cleaned.length === 0 && !existing) {
    return;
  }
  await writeLangSmithRepoConfig(repoRoot, { workspaces: cleaned });
}

/**
 * The first unused workspace key env var name given the ones already assigned, so
 * each workspace gets a distinct OPENWIKI_LANGSMITH_API_KEY(_n).
 */
export function nextLangSmithApiKeyEnv(existing: string[]): string {
  const used = new Set(existing);
  let name = PRIMARY_API_KEY_ENV;
  let n = 2;
  while (used.has(name)) {
    name = `${PRIMARY_API_KEY_ENV}_${n}`;
    n += 1;
  }
  return name;
}
