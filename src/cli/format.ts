import {
  getDefaultModelId,
  OPENWIKI_MODEL_ID_ENV_KEY,
  resolveConfiguredProvider,
} from "../config/constants.js";

/**
 * Reports whether a submitted chat message is the `/exit` command, ignoring
 * surrounding whitespace and case.
 */
export function isExitMessage(message: string): boolean {
  const normalizedMessage = message.trim().toLowerCase();

  return normalizedMessage === "/exit";
}

/**
 * Formats a count with the appropriate singular or plural noun.
 */
export function formatCount(
  count: number,
  singular: string,
  plural: string,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Abbreviates an absolute path under the home directory to a `~`-prefixed form,
 * leaving other paths unchanged.
 */
export function formatCwd(cwd: string): string {
  const home = process.env.HOME;

  if (home && cwd.startsWith(home)) {
    return `~${cwd.slice(home.length)}`;
  }

  return cwd;
}

/**
 * Resolves the model id to display, preferring an explicit id, then the model
 * env override, then the configured provider's default.
 */
export function getDisplayModelId(modelId: string | null): string {
  return (
    modelId ??
    process.env[OPENWIKI_MODEL_ID_ENV_KEY] ??
    getDefaultModelId(resolveConfiguredProvider())
  );
}
