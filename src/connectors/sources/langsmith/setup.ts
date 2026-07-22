import { createLangSmithApi } from "./api.js";
import {
  readLangSmithRepoConfig,
  sanitizeLangSmithApiBaseUrl,
  withoutProject,
  withProject,
  writeLangSmithRepoConfig,
} from "./repo-config.js";

/**
 * Default LangSmith API host root; EU workspaces override via config.
 */
const DEFAULT_API_BASE_URL = "https://api.smith.langchain.com";

/**
 * Env var holding the LangSmith API key.
 */
const LANGSMITH_API_KEY_ENV = "OPENWIKI_LANGSMITH_API_KEY";

/**
 * Result cap for a project search, so a broad substring match stays responsive.
 */
const SEARCH_LIMIT = 50;

/**
 * Reads the key with the connector's precedence (scoped var, then the
 * ecosystem-standard var).
 */
function readApiKey(): string | undefined {
  return process.env[LANGSMITH_API_KEY_ENV] ?? process.env.LANGSMITH_API_KEY;
}

/**
 * Searches the workspace for project names matching `query` (a name substring),
 * server-side and capped at SEARCH_LIMIT, so the picker stays fast on workspaces
 * with thousands of projects. Returns an empty list for a blank query or a
 * missing key, so the picker degrades to manual entry rather than enumerating
 * everything.
 */
export async function searchLangSmithProjects(
  query: string,
  apiBaseUrl?: string,
): Promise<string[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }
  const apiKey = readApiKey();
  if (!apiKey) {
    return [];
  }
  // The key rides along in an Authorization header, so validate any caller-
  // supplied host against the official-host allowlist before the SDK sees it.
  const api = createLangSmithApi(
    sanitizeLangSmithApiBaseUrl(apiBaseUrl) ?? DEFAULT_API_BASE_URL,
    apiKey,
  );
  return api.listProjectNames({ limit: SEARCH_LIMIT, nameContains: trimmed });
}

/**
 * Project names already configured in the repo file.
 */
export async function listConfiguredLangSmithSources(
  repoRoot: string,
): Promise<string[]> {
  const config = await readLangSmithRepoConfig(repoRoot);
  return (config?.projects ?? []).map((project) => project.name);
}

/**
 * Adds one project as a source in the committed repo file (idempotent).
 */
export async function addLangSmithSource(
  repoRoot: string,
  name: string,
): Promise<void> {
  const config = await readLangSmithRepoConfig(repoRoot);
  await writeLangSmithRepoConfig(repoRoot, withProject(config, name));
}

/**
 * Writes the committed repo file so its projects are exactly `names` (trimmed,
 * deduped, order preserved), keeping other config fields. This makes the setup
 * picker WYSIWYG: a project removed from the selection is removed from the file.
 * A no-op when there is nothing to write and no existing file, so an untouched
 * setup never creates one.
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

/**
 * Removes one project source from the committed repo file.
 */
export async function removeLangSmithSource(
  repoRoot: string,
  name: string,
): Promise<void> {
  const config = await readLangSmithRepoConfig(repoRoot);
  if (!config) {
    return;
  }
  await writeLangSmithRepoConfig(repoRoot, withoutProject(config, name));
}
