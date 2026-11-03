import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isFileNotFoundError } from "../../../platform/fs-errors.js";
import { resolveRepositoryWikiLocation } from "../../../repository-wiki/config.js";
import { assertRepositoryWikiPathSafe } from "../../../repository-wiki/ownership.js";
import {
  DEFAULT_REPOSITORY_WIKI_DIRECTORY,
  resolveRepositoryWikiRoot,
} from "../../../repository-wiki/paths.js";
import type { LangSmithProjectConfig } from "./types.js";

/**
 * One LangSmith workspace in the committed config: a region (via apiBaseUrl), the
 * env var naming its API key, and the projects to document there. A LangSmith key
 * is workspace- and region-bound, so cross-region documentation needs one entry
 * per workspace, each with its own key.
 */
export interface LangSmithWorkspaceConfig {
  /**
   * Env var name holding this workspace's API key. The key itself is never
   * committed; only the name lives in the file.
   */
  apiKeyEnv: string;

  /**
   * Projects to document in this workspace. One entry = one source.
   */
  projects: LangSmithProjectConfig[];

  /**
   * Non-default API host for EU workspaces.
   *
   * @default the connector's default host (https://api.smith.langchain.com)
   */
  apiBaseUrl?: string;
}

/**
 * The repo-committed LangSmith config. Committed so CI and every teammate
 * document the same set of workspaces and projects.
 */
export interface LangSmithRepoConfig {
  /**
   * Configured workspaces. One entry per LangSmith workspace/region.
   */
  workspaces: LangSmithWorkspaceConfig[];
}

/**
 * Official LangSmith API hosts the connector may talk to. The base URL is handed
 * to the SDK client together with the API key (sent as an Authorization header),
 * so a committed config must never be able to point it at an arbitrary host.
 */
const ALLOWED_API_HOSTS = new Set([
  "api.smith.langchain.com",
  "eu.api.smith.langchain.com",
  "apac.api.smith.langchain.com",
]);

/**
 * Env var names a committed config may name as an API-key source. Constrained to
 * the OpenWiki LangSmith namespace: apiKeyEnv decides which process.env value is
 * read and sent to the LangSmith host, so without this a committed config could
 * name an unrelated secret (e.g. AWS_SECRET_ACCESS_KEY) and exfiltrate it.
 */
const API_KEY_ENV_PATTERN = /^OPENWIKI_LANGSMITH_API_KEY(_[A-Z0-9]+)?$/;

/**
 * Absolute path of the committed LangSmith config for a repository.
 */
export function getLangSmithRepoConfigPath(
  repoRoot: string,
  wikiDirectory: string = DEFAULT_REPOSITORY_WIKI_DIRECTORY,
): string {
  return path.join(
    resolveRepositoryWikiRoot(repoRoot, wikiDirectory),
    ".langsmith.json",
  );
}

/**
 * Returns a normalized apiBaseUrl only when it is an https URL, carries no
 * embedded credentials, and targets an official LangSmith host; otherwise
 * undefined so callers fall back to the default host. Because the base URL
 * receives the user's API key, an unvalidated value from a repo-committed config
 * would let a malicious PR exfiltrate the key or drive SSRF to an internal host.
 */
export function sanitizeLangSmithApiBaseUrl(
  value: unknown,
): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    return undefined;
  }
  if (!ALLOWED_API_HOSTS.has(url.hostname)) {
    return undefined;
  }
  return url.origin;
}

/**
 * Returns the env var name only when it is inside the OpenWiki LangSmith
 * namespace; otherwise undefined so the workspace is dropped. Guards against a
 * committed config naming an unrelated secret as the key to send to LangSmith.
 */
export function sanitizeLangSmithApiKeyEnv(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return API_KEY_ENV_PATTERN.test(trimmed) ? trimmed : undefined;
}

/**
 * Reads and validates the committed config, or returns undefined when the file
 * is absent or malformed. Only named keys are read, so unexpected or
 * prototype-polluting keys never take effect.
 */
export async function readLangSmithRepoConfig(
  repoRoot: string,
  wikiDirectory?: string,
): Promise<LangSmithRepoConfig | undefined> {
  const directory =
    wikiDirectory ?? (await resolveRepositoryWikiLocation(repoRoot)).directory;
  await assertRepositoryWikiPathSafe(repoRoot, directory);
  let text: string;
  try {
    text = await readFile(
      getLangSmithRepoConfigPath(repoRoot, directory),
      "utf8",
    );
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
  return parseLangSmithRepoConfig(text);
}

/**
 * Parses config text into a LangSmithRepoConfig, or undefined when invalid. Each
 * workspace must carry an allowlisted apiKeyEnv and well-formed projects; any
 * workspace failing an allowlist (apiKeyEnv or apiBaseUrl) or shape check is
 * dropped rather than failing the whole config.
 */
export function parseLangSmithRepoConfig(
  text: string | undefined,
): LangSmithRepoConfig | undefined {
  if (!text) {
    return undefined;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }

  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.workspaces)) {
    return undefined;
  }

  const workspaces: LangSmithWorkspaceConfig[] = [];
  for (const entry of record.workspaces) {
    const workspace = parseWorkspace(entry);
    if (workspace) {
      workspaces.push(workspace);
    }
  }
  return { workspaces };
}

/**
 * Validates one workspace entry, copying only known allowlisted fields, or
 * undefined when it is malformed or fails an allowlist.
 */
function parseWorkspace(entry: unknown): LangSmithWorkspaceConfig | undefined {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return undefined;
  }
  const record = entry as Record<string, unknown>;

  const apiKeyEnv = sanitizeLangSmithApiKeyEnv(record.apiKeyEnv);
  if (!apiKeyEnv) {
    return undefined;
  }

  if (!Array.isArray(record.projects)) {
    return undefined;
  }
  const projects: LangSmithProjectConfig[] = [];
  for (const entryProject of record.projects) {
    if (
      entryProject === null ||
      typeof entryProject !== "object" ||
      Array.isArray(entryProject)
    ) {
      return undefined;
    }
    const project = entryProject as Record<string, unknown>;
    if (typeof project.name !== "string" || !project.name.trim()) {
      return undefined;
    }
    projects.push({ name: project.name.trim() });
  }

  const apiBaseUrl = sanitizeLangSmithApiBaseUrl(record.apiBaseUrl);
  return {
    apiKeyEnv,
    projects,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
  };
}

/**
 * Writes the committed config inside the repository's configured wiki root.
 */
export async function writeLangSmithRepoConfig(
  repoRoot: string,
  config: LangSmithRepoConfig,
  wikiDirectory?: string,
): Promise<void> {
  const directory =
    wikiDirectory ?? (await resolveRepositoryWikiLocation(repoRoot)).directory;
  await assertRepositoryWikiPathSafe(repoRoot, directory);
  const filePath = getLangSmithRepoConfigPath(repoRoot, directory);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
