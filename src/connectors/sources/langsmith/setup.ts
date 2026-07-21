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
 * Selectable projects for the setup picker, or a missing-key signal so the
 * wizard prompts for the key instead of calling the API without one.
 */
export type LangSmithProjectChoices =
  { ok: true; names: string[] } | { ok: false; reason: "missing-key" };

/**
 * Reads the key with the connector's precedence (scoped var, then the
 * ecosystem-standard var).
 */
function readApiKey(): string | undefined {
  return process.env[LANGSMITH_API_KEY_ENV] ?? process.env.LANGSMITH_API_KEY;
}

/**
 * Lists LangSmith project names for the picker, or a missing-key signal.
 */
export async function listLangSmithProjectChoices(
  apiBaseUrl?: string,
): Promise<LangSmithProjectChoices> {
  const apiKey = readApiKey();
  if (!apiKey) {
    return { ok: false, reason: "missing-key" };
  }
  // The key rides along in an Authorization header, so validate any caller-
  // supplied host against the official-host allowlist before the SDK sees it.
  const api = createLangSmithApi(
    sanitizeLangSmithApiBaseUrl(apiBaseUrl) ?? DEFAULT_API_BASE_URL,
    apiKey,
  );
  return { names: await api.listProjectNames(), ok: true };
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
