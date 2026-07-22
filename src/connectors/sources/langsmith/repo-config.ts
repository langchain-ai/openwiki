import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { OPEN_WIKI_DIR } from "../../../constants.js";
import { isFileNotFoundError } from "../../../fs-errors.js";
import type { LangSmithProjectConfig } from "./types.js";

/**
 * The repo-committed LangSmith config. Committed so CI and every teammate
 * document the same set of projects.
 */
export interface LangSmithRepoConfig {
  /**
   * Projects to document. One entry = one source.
   */
  projects: LangSmithProjectConfig[];

  /**
   * Fetch feedback for the pulled traces.
   *
   * @default false
   */
  includeFeedback?: boolean;

  /**
   * Non-default API host for EU workspaces.
   *
   * @default the connector's default host (https://api.smith.langchain.com)
   */
  apiBaseUrl?: string;
}

/**
 * Official LangSmith API hosts the connector may talk to. The base URL is handed
 * to the SDK client together with the API key (sent as an Authorization header),
 * so a committed config must never be able to point it at an arbitrary host.
 */
const ALLOWED_API_HOSTS = new Set([
  "api.smith.langchain.com",
  "eu.api.smith.langchain.com",
]);

/**
 * Absolute path of the committed LangSmith config for a repository.
 */
export function getLangSmithRepoConfigPath(repoRoot: string): string {
  return path.join(repoRoot, OPEN_WIKI_DIR, ".langsmith.json");
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
 * Reads and validates the committed config, or returns undefined when the file
 * is absent or malformed. Only named keys are read, so unexpected or
 * prototype-polluting keys never take effect.
 */
export async function readLangSmithRepoConfig(
  repoRoot: string,
): Promise<LangSmithRepoConfig | undefined> {
  let text: string;
  try {
    text = await readFile(getLangSmithRepoConfigPath(repoRoot), "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
  return parseLangSmithRepoConfig(text);
}

/**
 * Parses config text into a LangSmithRepoConfig, or undefined when invalid.
 * Every projects entry must be an object with a non-empty string name, and
 * apiBaseUrl is dropped unless it passes the host allowlist.
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
  if (!Array.isArray(record.projects)) {
    return undefined;
  }

  const projects: LangSmithProjectConfig[] = [];
  for (const entry of record.projects) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return undefined;
    }
    const project = entry as Record<string, unknown>;
    if (typeof project.name !== "string" || !project.name.trim()) {
      return undefined;
    }
    projects.push({ name: project.name.trim() });
  }

  const { apiBaseUrl, includeFeedback } = record;
  const safeApiBaseUrl = sanitizeLangSmithApiBaseUrl(apiBaseUrl);
  return {
    projects,
    ...(typeof includeFeedback === "boolean" ? { includeFeedback } : {}),
    ...(safeApiBaseUrl ? { apiBaseUrl: safeApiBaseUrl } : {}),
  };
}

/**
 * Writes the committed config, creating openwiki/ if needed. Mirrors
 * saveRepositoryWikiInstructions: a plain write to a fixed path under the repo's
 * openwiki/ directory, so containment holds by construction.
 */
export async function writeLangSmithRepoConfig(
  repoRoot: string,
  config: LangSmithRepoConfig,
): Promise<void> {
  const filePath = getLangSmithRepoConfigPath(repoRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
