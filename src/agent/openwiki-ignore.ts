import { readFile } from "node:fs/promises";
import path from "node:path";
import { isFileNotFoundError } from "../platform/fs-errors.js";

/**
 * Name of the gitignore-style file that lists paths the doc agent must not touch.
 */
export const OPENWIKI_IGNORE_FILE = ".openwikiignore";

/**
 * One compiled `.openwikiignore` pattern.
 *
 * A rule owns both the compiled matcher and the decision of whether a given
 * path matches it. Rules are never evaluated alone: {@link OpenWikiIgnore}
 * applies them in file order with last-match-wins semantics, which is what lets
 * a later negated (`!`) rule re-include a path an earlier rule excluded.
 */
export class OpenWikiIgnoreRule {
  /**
   * Compile one `.openwikiignore` pattern into a rule.
   *
   * Peels off the gitignore modifiers before building the matcher: a leading `!`
   * marks negation, a leading `/` (or embedded slash) anchors the pattern to the
   * repo root, and a trailing `/` scopes it to directories. Returns `undefined`
   * if the pattern is empty after stripping those markers.
   */
  static compile(pattern: string): OpenWikiIgnoreRule | undefined {
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
      return undefined;
    }

    return new OpenWikiIgnoreRule(
      directoryOnly,
      OpenWikiIgnoreRule.createMatcher(normalizedPattern, anchored),
      negated,
    );
  }

  /**
   * Build the regex that tests a normalized path against one pattern.
   *
   * Anchored patterns (leading `/`) and patterns that contain a slash are
   * matched from the start of the path; a trailing `(?:/.*)?` lets a directory
   * pattern also match everything nested beneath it. Unanchored, slash-free
   * patterns (e.g. `*.log`) match at any path segment via the `(^|/)` prefix.
   *
   * The `i` flag is deliberate and security-relevant: on case-insensitive
   * filesystems (macOS APFS/HFS+, Windows NTFS) `Secrets/token.txt` and
   * `secrets/token.txt` resolve to the same file, so a case-sensitive rule
   * would let an alternate-cased spelling slip past an exclusion. Matching
   * case-insensitively everywhere closes that bypass; the worst case on a
   * genuinely case-sensitive filesystem is over-excluding a case variant,
   * which is the safe direction for an access gate.
   */
  private static createMatcher(pattern: string, anchored: boolean): RegExp {
    const containsSlash = pattern.includes("/");
    const source = OpenWikiIgnoreRule.globToRegexSource(pattern);

    if (anchored || containsSlash) {
      return new RegExp(`^${source}(?:/.*)?$`, "iu");
    }

    return new RegExp(`(^|/)${source}(/.*)?$`, "iu");
  }

  /**
   * Translate a gitignore-style glob into a regex source fragment.
   *
   * Supported wildcards: `**\/` spans zero or more directories, a bare `**`
   * spans anything, `*` matches within a single path segment, and `?` matches
   * one non-slash character. All other characters are escaped as literals.
   */
  private static globToRegexSource(pattern: string): string {
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

      source += OpenWikiIgnoreRule.escapeRegex(character);
    }

    return source;
  }

  /**
   * Escape a single character so it is treated literally inside a regex.
   */
  private static escapeRegex(value: string): string {
    return value.replace(/[|\\{}()[\]^$+*?.]/gu, "\\$&");
  }

  /**
   * Whether the pattern only matches directories (trailing `/` in the source,
   * e.g. `build/`). Directory-only rules still match files nested under the
   * directory; see {@link matches}.
   */
  private readonly directoryOnly: boolean;

  /**
   * Compiled matcher for the glob, tested against a normalized repo-relative path.
   */
  private readonly matcher: RegExp;

  /**
   * Whether the source line began with `!`, re-including a previously excluded path.
   */
  readonly negated: boolean;

  private constructor(
    directoryOnly: boolean,
    matcher: RegExp,
    negated: boolean,
  ) {
    this.directoryOnly = directoryOnly;
    this.matcher = matcher;
    this.negated = negated;
  }

  /**
   * Test whether this rule matches a normalized path.
   *
   * A directory-only rule matches only when the target is itself a directory or
   * sits under one (the path contains a `/`), so `build/` never excludes a
   * top-level file literally named `build`.
   */
  matches(filePath: string, isDirectory: boolean): boolean {
    if (!this.matcher.test(filePath)) {
      return false;
    }

    if (!this.directoryOnly) {
      return true;
    }

    return isDirectory || filePath.includes("/");
  }
}

/**
 * The full, ordered set of `.openwikiignore` rules for one run.
 *
 * This is the aggregate matcher over every rule, not a single rule:
 * {@link ignores} can only answer "is this path excluded?" by walking the rules
 * in file order, because negation (`!`) is only meaningful relative to the rules
 * that precede it. It is threaded through the agent backend, prompt, and run
 * context as one cohesive object so the matching semantics live in exactly one
 * place.
 *
 * Matching aims to be gitignore-compatible: last-match-wins, `*`/`**`/`?` globs,
 * leading-`/` anchoring to the repo root, and trailing-`/` directory scoping.
 */
export class OpenWikiIgnore {
  /**
   * Parse raw `.openwikiignore` file contents into an aggregate matcher.
   *
   * Splits on newlines, drops blank lines and `#` comments, and keeps the
   * remaining lines as patterns.
   */
  static parse(contents: string): OpenWikiIgnore {
    return new OpenWikiIgnore(
      contents
        .split(/\r?\n/u)
        .map(parseIgnoreLine)
        .filter((line) => line !== undefined),
    );
  }

  /**
   * Load and parse `.openwikiignore` from a repo root.
   *
   * A missing file is treated as "no rules" (an inactive matcher), not an error;
   * any other read failure is rethrown.
   *
   * @param cwd - Absolute path to the repository root to read the file from.
   */
  static async load(cwd: string): Promise<OpenWikiIgnore> {
    try {
      const contents = await readFile(
        path.join(cwd, OPENWIKI_IGNORE_FILE),
        "utf8",
      );

      return OpenWikiIgnore.parse(contents);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return OpenWikiIgnore.parse("");
      }

      throw error;
    }
  }

  /**
   * The raw, non-comment pattern lines, preserved for prompt/display purposes.
   */
  readonly patterns: string[];

  /**
   * The compiled rules, in file order; invalid/empty patterns are dropped.
   */
  private readonly rules: OpenWikiIgnoreRule[];

  constructor(patterns: string[]) {
    this.patterns = patterns;
    this.rules = patterns
      .map((pattern) => OpenWikiIgnoreRule.compile(pattern))
      .filter((rule) => rule !== undefined);
  }

  /**
   * Whether any usable rule was parsed. Enforcement is a no-op when this is false.
   */
  get isActive(): boolean {
    return this.rules.length > 0;
  }

  /**
   * Report whether `filePath` is excluded by the ruleset.
   *
   * The path is first canonicalized by {@link normalizeIgnorePath} so that
   * equivalent spellings (`./secrets/x`, `secrets/../secrets/x`, `/secrets/x`)
   * cannot slip past an anchored rule. Rules are then applied in file order and
   * the last matching rule wins, so a trailing `!pattern` can re-include a path.
   *
   * @param filePath - A repo-relative (or root-anchored) path to test.
   * @param isDirectory - Whether the path refers to a directory; lets
   *   directory-only rules match the directory entry itself. Defaults to false.
   */
  ignores(filePath: string, isDirectory = false): boolean {
    const normalizedPath = normalizeIgnorePath(filePath);

    if (normalizedPath.length === 0) {
      return false;
    }

    let ignored = false;

    for (const rule of this.rules) {
      if (rule.matches(normalizedPath, isDirectory)) {
        ignored = !rule.negated;
      }
    }

    return ignored;
  }
}

/**
 * Canonicalize a path into the repo-relative form that rule matchers expect.
 *
 * This is a security boundary, not cosmetic cleanup: naive string stripping
 * would let equivalent spellings dodge an anchored rule. For example, with the
 * rule `/secrets`, the path `./secrets/token.txt` would fail to match once the
 * leading `./` was present, and `secrets/../secrets/token.txt` would not match
 * either, leaking an excluded file. So we normalize `.`/`..` segments with
 * `path.posix.normalize`, mirroring the confinement check in `isOpenWikiDocsPath`.
 *
 * The path is anchored to `/` before normalizing so that any `..` cannot escape
 * above the repo root (`../foo` collapses to `foo`); the leading and trailing
 * slashes are then stripped back off to yield a bare repo-relative path.
 *
 * @param filePath - A path in any spelling (backslashes, leading `/`, `.`/`..`).
 */
function normalizeIgnorePath(filePath: string): string {
  const slashed = filePath.replace(/\\/gu, "/");
  const normalized = path.posix.normalize(`/${slashed.replace(/^\/+/u, "")}`);

  return normalized.replace(/^\/+/u, "").replace(/\/+$/u, "");
}

/**
 * Trim one raw line and decide whether it is a usable pattern.
 *
 * Returns the trimmed pattern, or `undefined` for blank lines and `#` comments.
 */
function parseIgnoreLine(line: string): string | undefined {
  const trimmedLine = line.trim();

  if (trimmedLine.length === 0 || trimmedLine.startsWith("#")) {
    return undefined;
  }

  return trimmedLine;
}
