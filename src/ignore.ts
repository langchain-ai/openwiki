import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * A parsed ignore rule from .openwikiignore.
 */
export interface IgnoreRule {
  /** The original pattern string. */
  pattern: string;
  /** Whether this is a negation rule (starts with !). */
  negated: boolean;
  /** Whether the pattern only matches directories (ends with /). */
  directoryOnly: boolean;
  /** The regex pattern derived from the glob pattern. */
  regex: RegExp;
}

/**
 * Default ignore patterns that are always applied.
 * These protect against common pitfalls (binary dirs, version control, etc.).
 */
const DEFAULT_IGNORE_PATTERNS = [
  ".git/",
  ".svn/",
  ".hg/",
  "node_modules/",
  "__pycache__/",
  "openwiki/",
];

/**
 * Converts a gitignore-style glob pattern to a RegExp.
 * Supports: *, **, ?, literal paths, directory-only (trailing /).
 */
function globToRegex(pattern: string, directoryOnly: boolean): RegExp {
  let regexStr = "";
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches any number of directories
        if (pattern[i + 2] === "/") {
          regexStr += "(?:[^/]+/)*";
          i += 3;
        } else {
          regexStr += ".*";
          i += 2;
        }
      } else {
        // * matches anything except /
        regexStr += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      regexStr += "[^/]";
      i += 1;
    } else if (ch === ".") {
      regexStr += "\\.";
      i += 1;
    } else if (ch === "\\") {
      // Escape next character
      if (i + 1 < pattern.length) {
        regexStr += escapeRegex(pattern[i + 1]);
        i += 2;
      } else {
        regexStr += "\\";
        i += 1;
      }
    } else {
      regexStr += escapeRegex(ch);
      i += 1;
    }
  }

  if (directoryOnly) {
    regexStr += "(?:/.*)?$";
  } else {
    regexStr += "(?:/.*)?$";
  }

  return new RegExp(`^${regexStr}$`, "i");
}

function escapeRegex(ch: string): string {
  // Escape special regex characters
  return ch.replace(/[\\^$|?+{}[\]()]/g, "\\$&");
}

/**
 * Parses a .openwikiignore file content into rules.
 */
export function parseIgnoreRules(content: string): IgnoreRule[] {
  const lines = content.split(/\r?\n/);
  const rules: IgnoreRule[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    let pattern = trimmed;
    let negated = false;

    if (pattern.startsWith("!")) {
      negated = true;
      pattern = pattern.slice(1);
    }

    let directoryOnly = false;

    if (pattern.endsWith("/")) {
      directoryOnly = true;
      pattern = pattern.slice(0, -1);
    }

    // Remove leading slash (patterns are relative to repo root)
    if (pattern.startsWith("/")) {
      pattern = pattern.slice(1);
    }

    const regex = globToRegex(pattern, directoryOnly);

    rules.push({ pattern: trimmed, negated, directoryOnly, regex });
  }

  return rules;
}

/**
 * Loads ignore rules from a .openwikiignore file.
 * Returns default rules if the file doesn't exist.
 */
export async function loadIgnoreRules(cwd: string): Promise<IgnoreRule[]> {
  const ignoreFilePath = path.join(cwd, ".openwikiignore");

  try {
    const content = await readFile(ignoreFilePath, "utf8");
    const userRules = parseIgnoreRules(content);

    // Default rules first, then user rules (user rules can negate defaults)
    return [
      ...DEFAULT_IGNORE_PATTERNS.map((p) => parseIgnoreRules(p)[0]),
      ...userRules,
    ];
  } catch {
    // File doesn't exist or can't be read — use only defaults
    return DEFAULT_IGNORE_PATTERNS.map((p) => parseIgnoreRules(p)[0]);
  }
}

/**
 * Determines if a relative path should be ignored based on the given rules.
 * Follows gitignore semantics: later rules override earlier ones.
 */
export function shouldIgnore(
  relativePath: string,
  rules: IgnoreRule[],
): boolean {
  // Normalize path separators
  const normalizedPath = relativePath.replace(/\\/gu, "/");
  let ignored = false;

  for (const rule of rules) {
    // For directory-only rules, check if the path is a directory (ends with /)
    // or if the path matches as a directory prefix
    const pathToTest = rule.directoryOnly
      ? normalizedPath.endsWith("/")
        ? normalizedPath
        : `${normalizedPath}/`
      : normalizedPath;

    if (rule.regex.test(pathToTest)) {
      ignored = !rule.negated;
    }
  }

  return ignored;
}
