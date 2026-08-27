import path from "node:path";
import { EvidenceResourceError } from "../../core/errors.js";

/**
 * Repository evidence URI prefix.
 */
export const REPOSITORY_EVIDENCE_PREFIX = "repo://";

/**
 * Inclusive one-based source line range.
 */
export interface RepositoryLineRange {
  /**
   * First selected source line.
   */
  startLine: number;

  /**
   * Last selected source line.
   */
  endLine: number;
}

/**
 * Parsed repository evidence identity.
 */
export interface RepositoryEvidenceResource {
  /**
   * Normalized repository-relative POSIX path.
   */
  path: string;

  /**
   * Optional language-agnostic source line range.
   *
   * @default undefined, which selects whole-file evidence.
   */
  range?: RepositoryLineRange;
}

/**
 * Formats a validated repository evidence identity canonically.
 *
 * @param resource - Normalized repository path and optional line range.
 * @returns Canonical `repo://path#Lx-Ly` resource.
 */
export function formatRepositoryEvidenceResource(
  resource: RepositoryEvidenceResource,
): string {
  let encodedPath: string;
  try {
    encodedPath = resource.path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
  } catch {
    throw new EvidenceResourceError(
      "Repository evidence contains an invalid Unicode sequence.",
    );
  }
  const fragment =
    resource.range === undefined ? undefined : formatLineRange(resource.range);

  const formatted = `${REPOSITORY_EVIDENCE_PREFIX}${encodedPath}${
    fragment === undefined ? "" : `#${fragment}`
  }`;
  const parsed = parseRepositoryEvidenceResource(formatted);
  if (
    parsed.path !== resource.path ||
    !areLineRangesEqual(parsed.range, resource.range)
  ) {
    throw new EvidenceResourceError(
      `Repository evidence is not normalized: ${formatted}`,
    );
  }
  return formatted;
}

/**
 * Parses and validates a `repo://path#Lx-Ly` resource.
 *
 * @param resource - Repository evidence URI to parse.
 * @returns Canonical repository path and optional line range.
 */
export function parseRepositoryEvidenceResource(
  resource: string,
): RepositoryEvidenceResource {
  if (!resource.startsWith(REPOSITORY_EVIDENCE_PREFIX)) {
    throw new EvidenceResourceError(
      `Unsupported evidence resource: ${resource}`,
    );
  }

  const body = resource.slice(REPOSITORY_EVIDENCE_PREFIX.length);
  const fragmentIndex = body.indexOf("#");
  const encodedPath =
    fragmentIndex === -1 ? body : body.slice(0, fragmentIndex);
  const encodedFragment =
    fragmentIndex === -1 ? undefined : body.slice(fragmentIndex + 1);
  if (encodedFragment?.includes("#")) {
    throw new EvidenceResourceError(
      `Evidence resource contains an unescaped fragment delimiter: ${resource}`,
    );
  }

  let decodedPath: string;
  let decodedFragment: string | undefined;
  try {
    decodedPath = decodeURIComponent(encodedPath);
    decodedFragment =
      encodedFragment === undefined
        ? undefined
        : decodeURIComponent(encodedFragment);
  } catch {
    throw new EvidenceResourceError(
      `Evidence resource contains invalid percent encoding: ${resource}`,
    );
  }

  if (containsControlCharacter(decodedPath)) {
    throw new EvidenceResourceError(
      `Evidence path contains a control character: ${resource}`,
    );
  }
  if (
    decodedFragment !== undefined &&
    containsControlCharacter(decodedFragment)
  ) {
    throw new EvidenceResourceError(
      `Evidence line range contains a control character: ${resource}`,
    );
  }

  const normalized = path.posix
    .normalize(decodedPath.replace(/\\/gu, "/"))
    .replace(/^\.\//u, "");
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized) ||
    /^[a-z]:\//iu.test(normalized)
  ) {
    throw new EvidenceResourceError(
      `Evidence path must remain inside the repository: ${resource}`,
    );
  }
  const normalizedLower = normalized.toLowerCase();
  if (
    normalizedLower === ".git" ||
    normalizedLower.startsWith(".git/") ||
    normalizedLower === "openwiki" ||
    normalizedLower.startsWith("openwiki/")
  ) {
    throw new EvidenceResourceError(
      `Evidence cannot reference Git metadata or generated OpenWiki output: ${resource}`,
    );
  }
  const range =
    decodedFragment === undefined
      ? undefined
      : parseLineRange(decodedFragment, resource);

  return {
    path: normalized,
    ...(range === undefined ? {} : { range }),
  };
}

/**
 * Parses one canonical GitHub-style line fragment.
 *
 * A single-line fragment such as `L8` is accepted as input and canonicalized
 * to `L8-L8` when persisted.
 *
 * @param fragment - Decoded resource fragment.
 * @param resource - Complete resource used in diagnostics.
 * @returns Validated inclusive line range.
 */
function parseLineRange(
  fragment: string,
  resource: string,
): RepositoryLineRange {
  const match = /^L([1-9]\d*)(?:-L([1-9]\d*))?$/u.exec(fragment);
  if (!match) {
    throw new EvidenceResourceError(
      `Evidence fragment must be a line range such as #L10-L24: ${resource}`,
    );
  }
  const startLine = Number(match[1]);
  const endLine = Number(match[2] ?? match[1]);
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)) {
    throw new EvidenceResourceError(
      `Evidence line range exceeds the supported integer range: ${resource}`,
    );
  }
  if (endLine < startLine) {
    throw new EvidenceResourceError(
      `Evidence line range must end at or after its start: ${resource}`,
    );
  }
  return { startLine, endLine };
}

/**
 * Formats an inclusive line range canonically.
 *
 * @param range - Candidate range.
 * @returns Canonical GitHub-style fragment without `#`.
 */
function formatLineRange(range: RepositoryLineRange): string {
  const { startLine, endLine } = range;
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    throw new EvidenceResourceError(
      "Repository evidence line range is invalid.",
    );
  }
  return `L${startLine}-L${endLine}`;
}

/**
 * Compares optional line ranges by value.
 *
 * @param left - Parsed range.
 * @param right - Formatter input range.
 * @returns Whether both ranges are absent or equal.
 */
function areLineRangesEqual(
  left: RepositoryLineRange | undefined,
  right: RepositoryLineRange | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.startLine === right.startLine &&
      left.endLine === right.endLine)
  );
}

/**
 * Detects characters that cannot safely participate in source identities.
 *
 * @param value - Decoded resource component.
 * @returns Whether the value contains a C0 or delete control character.
 */
function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}
