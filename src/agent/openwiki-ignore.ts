import { readFile } from "node:fs/promises";
import path from "node:path";
import { isFileNotFoundError } from "../fs-errors.js";

export const OPENWIKI_IGNORE_FILE = ".openwikiignore";

type IgnoreRule = {
  directoryOnly: boolean;
  matcher: RegExp;
  negated: boolean;
};

export class OpenWikiIgnoreRules {
  readonly patterns: string[];
  private readonly rules: IgnoreRule[];

  constructor(patterns: string[]) {
    this.patterns = patterns;
    this.rules = patterns.map(createRule).filter((rule) => rule !== null);
  }

  get isActive(): boolean {
    return this.rules.length > 0;
  }

  ignores(filePath: string, isDirectory = false): boolean {
    const normalizedPath = normalizeIgnorePath(filePath);

    if (normalizedPath.length === 0) {
      return false;
    }

    let ignored = false;

    for (const rule of this.rules) {
      if (matchesRule(rule, normalizedPath, isDirectory)) {
        ignored = !rule.negated;
      }
    }

    return ignored;
  }
}

export async function loadOpenWikiIgnore(
  cwd: string,
): Promise<OpenWikiIgnoreRules> {
  try {
    const contents = await readFile(
      path.join(cwd, OPENWIKI_IGNORE_FILE),
      "utf8",
    );

    return createOpenWikiIgnoreRules(contents);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return createOpenWikiIgnoreRules("");
    }

    throw error;
  }
}

export function createOpenWikiIgnoreRules(
  contents: string,
): OpenWikiIgnoreRules {
  return new OpenWikiIgnoreRules(
    contents
      .split(/\r?\n/u)
      .map(parseIgnoreLine)
      .filter((line) => line !== null),
  );
}

export function normalizeIgnorePath(filePath: string): string {
  return filePath
    .replace(/\\/gu, "/")
    .replace(/^\/+/u, "")
    .replace(/\/+$/u, "");
}

function parseIgnoreLine(line: string): string | null {
  const trimmedLine = line.trim();

  if (trimmedLine.length === 0 || trimmedLine.startsWith("#")) {
    return null;
  }

  return trimmedLine;
}

function createRule(pattern: string): IgnoreRule | null {
  let normalizedPattern = pattern.replace(/\\/gu, "/");
  const negated = normalizedPattern.startsWith("!");

  if (negated) {
    normalizedPattern = normalizedPattern.slice(1);
  }

  normalizedPattern = normalizedPattern
    .replace(/^\.\/+/u, "")
    .replace(/\/+/gu, "/");

  const anchored = normalizedPattern.startsWith("/");
  const directoryOnly = normalizedPattern.endsWith("/");
  normalizedPattern = normalizedPattern
    .replace(/^\/+/u, "")
    .replace(/\/+$/u, "");

  if (normalizedPattern.length === 0) {
    return null;
  }

  return {
    directoryOnly,
    matcher: createPatternMatcher(normalizedPattern, anchored),
    negated,
  };
}

function createPatternMatcher(pattern: string, anchored: boolean): RegExp {
  const containsSlash = pattern.includes("/");
  const source = globToRegexSource(pattern);

  if (anchored || containsSlash) {
    return new RegExp(`^${source}(?:/.*)?$`, "u");
  }

  return new RegExp(`(^|/)${source}(/.*)?$`, "u");
}

function matchesRule(
  rule: IgnoreRule,
  filePath: string,
  isDirectory: boolean,
): boolean {
  if (!rule.matcher.test(filePath)) {
    return false;
  }

  if (!rule.directoryOnly) {
    return true;
  }

  return isDirectory || filePath.includes("/");
}

function globToRegexSource(pattern: string): string {
  let source = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    const nextCharacter = pattern[index + 1];

    if (character === "*" && nextCharacter === "*") {
      const characterAfterGlobstar = pattern[index + 2];

      if (characterAfterGlobstar === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }

      continue;
    }

    if (character === "*") {
      source += "[^/]*";
      continue;
    }

    if (character === "?") {
      source += "[^/]";
      continue;
    }

    source += escapeRegex(character);
  }

  return source;
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/gu, "\\$&");
}
