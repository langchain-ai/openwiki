import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { OPEN_WIKI_DIR } from "../../../constants.js";
import { isFileNotFoundError } from "../../../fs-errors.js";
import type { LangSmithProjectConfig } from "./types.js";

/**
 * The repo-committed LangSmith config. Projects are objects so each can carry its
 * own trace budget. Committed so CI and every teammate document the same set.
 */
export interface LangSmithRepoConfig {
  /**
   * Projects to document. One entry = one source.
   */
  projects: LangSmithProjectConfig[];

  /**
   * Default most-recent traces per project; a project may override.
   *
   * @default 10
   */
  maxTraces?: number;

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
 * Every `projects` entry must be an object with a non-empty string `name`.
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
    projects.push({
      name: project.name.trim(),
      ...(typeof project.maxTraces === "number" && project.maxTraces > 0
        ? { maxTraces: Math.floor(project.maxTraces) }
        : {}),
    });
  }

  const { apiBaseUrl, includeFeedback, maxTraces } = record;
  return {
    projects,
    ...(typeof maxTraces === "number" && maxTraces > 0
      ? { maxTraces: Math.floor(maxTraces) }
      : {}),
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
 * Returns config with one project added by name (deduped, order preserved), for
 * the interactive "add a LangSmith source" flow.
 */
export function withProject(
  config: LangSmithRepoConfig | undefined,
  name: string,
): LangSmithRepoConfig {
  const base = config ?? { projects: [] };
  const trimmed = name.trim();
  if (!trimmed || base.projects.some((project) => project.name === trimmed)) {
    return base;
  }
  return { ...base, projects: [...base.projects, { name: trimmed }] };
}

/**
 * Returns config with one project removed by exact name.
 */
export function withoutProject(
  config: LangSmithRepoConfig,
  name: string,
): LangSmithRepoConfig {
  return {
    ...config,
    projects: config.projects.filter((project) => project.name !== name),
  };
}
