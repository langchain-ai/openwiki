import { readFile } from "node:fs/promises";
import path from "node:path";
import { isFileNotFoundError } from "./fs-errors.js";

/**
 * The name of the OpenWiki ignore file placed at the repository root.
 * Uses gitignore-style patterns to exclude files and directories from
 * documentation generation and change detection.
 */
export const OPENWIKI_IGNORE_FILENAME = ".openwikiignore";

/**
 * Built-in default ignore patterns that are always active, even without
 * a .openwikiignore file. These exclude files and directories that are
 * never useful for documentation.
 *
 * - `__pycache__/`: Python compiled bytecode caches (.pyc files)
 * - `*.pyc`: Standalone Python compiled bytecode files
 */
export const DEFAULT_IGNORE_PATTERNS: string[] = [
  "__pycache__/",
  "*.pyc",
];

/**
 * A compiled ignore rule: a pattern converted to a RegExp with optional negation.
 * Supports the subset of gitignore semantics listed in {@link parseIgnorePattern}.
 */
export type IgnoreRule = {
  /** True when the matched path should be excluded. */
  negate: boolean;
  /** True when the rule only applies to directories (trailing `/`). */
  directoryOnly: boolean;
  /** Compiled regex tested against forward-slash–normalized paths. */
  regex: RegExp;
};

/**
 * Parsed set of ignore rules ready for matching.
 */
export type IgnoreRules = IgnoreRule[];

/**
 * Loads and parses `.openwikiignore` from the repository root, combined with
 * built-in default ignore patterns.
 * User-defined patterns are merged AFTER defaults, so user negations (`!`)
 * can override built-in excludes.
 */
export async function loadOpenWikiIgnore(cwd: string): Promise<IgnoreRules> {
  const ignoreFile = path.join(cwd, OPENWIKI_IGNORE_FILENAME);
  const defaults = parseIgnoreContent(DEFAULT_IGNORE_PATTERNS.join("\n"));

  try {
    const content = await readFile(ignoreFile, "utf8");
    return [...defaults, ...parseIgnoreContent(content)];
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return defaults;
    }
    throw error;
  }
}

/**
 * Parses gitignore-style text content into compiled rules.
 *
 * Supported pattern forms (matching gitignore semantics):
 * - `#` comment lines are ignored
 * - Empty lines are ignored
 * - Trailing `/` restricts the pattern to directories only
 * - Leading `/` anchors the pattern to the repository root
 * - `!` negates the pattern (re-includes matching paths)
 * - `*` matches any characters except `/`
 * - `**` matches any characters including `/`
 * - `?` matches a single character except `/`
 * - Lines without a leading `/` or an interior `/` match basenames
 *   anywhere in the tree (like `.gitignore`)
 */
export function parseIgnoreContent(content: string): IgnoreRules {
  const rules: IgnoreRules = [];
  const lines = content.split(/\r?\n/u);

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    // Skip comments and empty lines
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const rule = compileIgnorePattern(trimmed);

    if (rule) {
      rules.push(rule);
    }
  }

  return rules;
}

/**
 * Checks whether a path (relative to the repository root, forward-slash
 * normalized) matches any active ignore rule.
 *
 * A path is ignored when:
 * 1. It matches at least one non-negated rule, AND
 * 2. It does NOT match any subsequent negated rule.
 *
 * Directory-only patterns (trailing `/`) match the directory itself AND
 * every file or nested directory inside it. For example, a `build/` rule
 * ignores both the `build` directory entry and paths like `build/output.js`.
 */
export function isPathIgnored(
  relativePath: string,
  rules: IgnoreRules,
): boolean {
  const normalizedPath = relativePath.replace(/\\/gu, "/");
  let ignored = false;

  for (const rule of rules) {
    // Directory-only rules match the directory itself or any descendant
    if (rule.directoryOnly) {
      const segments = normalizedPath.split("/");
      const ancestorPaths: string[] = [];

      for (let i = 1; i <= segments.length; i += 1) {
        ancestorPaths.push(segments.slice(0, i).join("/"));
      }

      const matchesAncestor = ancestorPaths.some((ancestor) =>
        rule.regex.test(ancestor),
      );

      if (matchesAncestor) {
        ignored = !rule.negate;
      }

      continue;
    }

    if (rule.regex.test(normalizedPath)) {
      ignored = !rule.negate;
    }
  }

  return ignored;
}

/**
 * Compiles a single gitignore-style pattern line into an IgnoreRule.
 */
function compileIgnorePattern(pattern: string): IgnoreRule | null {
  let working = pattern;
  let negate = false;
  let directoryOnly = false;

  // Negation prefix
  if (working.startsWith("!")) {
    negate = true;
    working = working.slice(1).trimStart();
  }

  // Trailing slash indicates directory-only
  if (working.endsWith("/")) {
    directoryOnly = true;
    working = working.slice(0, -1);
  }

  if (working.length === 0) {
    return null;
  }

  return {
    negate,
    directoryOnly,
    regex: compileGlobToRegex(working),
  };
}

/**
 * Converts a gitignore glob pattern to a RegExp.
 *
 * Handles:
 * - Leading `/` for root-anchored patterns
 * - `**` for directory-spanning wildcards
 * - `*` for single-level wildcards
 * - `?` for single-character wildcards
 * - Standard regex escaping for other special characters
 * - Patterns without `/` match basenames anywhere (like gitignore)
 */
function compileGlobToRegex(pattern: string): RegExp {
  let anchored = false;
  let working = pattern;

  // Leading slash anchors to root
  if (working.startsWith("/")) {
    anchored = true;
    working = working.slice(1);
  }

  // If the pattern has no slash, it matches basenames anywhere
  const hasSlash = working.includes("/");

  let regexStr = "^";

  if (!anchored && !hasSlash) {
    // Match basename anywhere: allow any prefix before the pattern
    regexStr += "(?:.*/)?";
  }

  // Escape regex chars except *, ?, which we translate
  let i = 0;

  while (i < working.length) {
    const char = working[i];

    if (char === "*" && working[i + 1] === "*" && working[i + 2] === "/") {
      // **/ matches any number of directory segments (including zero)
      regexStr += "(?:.*/)?";
      i += 3;
      continue;
    }

    if (char === "*" && working[i + 1] === "*" && working[i + 2] === undefined) {
      // Trailing ** matches everything including /
      regexStr += ".*";
      i += 2;
      continue;
    }

    if (char === "*") {
      // Single * matches anything except /
      regexStr += "[^/]*";
      i += 1;
      continue;
    }

    if (char === "?") {
      regexStr += "[^/]";
      i += 1;
      continue;
    }

    // Escape other special regex chars
    if ("+.()[]{}$^|\\".includes(char)) {
      regexStr += `\\${char}`;
    } else {
      regexStr += char;
    }

    i += 1;
  }

  regexStr += "$";

  return new RegExp(regexStr, "u");
}
