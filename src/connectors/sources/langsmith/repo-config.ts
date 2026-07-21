import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { OPEN_WIKI_DIR } from "../../../constants.js";
import { isFileNotFoundError } from "../../../fs-errors.js";

/**
 * The repo-committed LangSmith source list. One project name per source; the API
 * key is never stored here. Committed so CI and every teammate document the same
 * projects.
 */
export interface LangSmithRepoConfig {
  /**
   * LangSmith project names that document this repository. Each is one source.
   */
  projects: string[];

  /**
   * Fetch feedback for error runs. Optional; defaults to false.
   */
  includeFeedback?: boolean;

  /**
   * Non-default API host for EU workspaces. Optional.
   */
  apiBaseUrl?: string;
}

/**
 * Absolute path of the committed LangSmith config for a repository.
 */
export function getLangSmithRepoConfigPath(repoRoot: string): string {
  return path.join(repoRoot, OPEN_WIKI_DIR, "langsmith.json");
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
  const projects = record.projects;
  if (
    !Array.isArray(projects) ||
    projects.some((name) => typeof name !== "string" || !name.trim())
  ) {
    return undefined;
  }

  const apiBaseUrl = record.apiBaseUrl;
  const includeFeedback = record.includeFeedback;
  return {
    projects: projects.map((name) => (name as string).trim()),
    ...(typeof includeFeedback === "boolean" ? { includeFeedback } : {}),
    ...(typeof apiBaseUrl === "string" && apiBaseUrl.trim()
      ? { apiBaseUrl: apiBaseUrl.trim() }
      : {}),
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

/**
 * Returns config with one project added (deduped, order preserved), for the
 * interactive "add a LangSmith source" flow.
 */
export function withProject(
  config: LangSmithRepoConfig | undefined,
  project: string,
): LangSmithRepoConfig {
  const base = config ?? { projects: [] };
  const name = project.trim();
  if (!name || base.projects.includes(name)) {
    return base;
  }
  return { ...base, projects: [...base.projects, name] };
}

/**
 * Returns config with one project removed, for "remove a LangSmith source".
 */
export function withoutProject(
  config: LangSmithRepoConfig,
  project: string,
): LangSmithRepoConfig {
  return {
    ...config,
    projects: config.projects.filter((name) => name !== project),
  };
}
