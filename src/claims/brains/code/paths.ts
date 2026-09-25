import path from "node:path";
import { ClaimSessionError } from "../../core/errors.js";

/**
 * OpenWiki-owned claims directory relative to the wiki root.
 */
export const CLAIMS_DIRECTORY = ".claims";

/**
 * Markdown basenames excluded from factual claim persistence.
 */
export const RESERVED_WIKI_FILES: ReadonlySet<string> = new Set([
  "index.md",
  "log.md",
  "instructions.md",
]);

/**
 * Canonicalizes a virtual generated-page path.
 *
 * @param page - Agent-supplied page path.
 * @returns Canonical `/openwiki/...md` path.
 */
export function normalizeWikiPagePath(page: string): string {
  const slashed = page.trim().replace(/\\/gu, "/");
  if (hasTraversalSegment(slashed)) {
    throw new ClaimSessionError(
      `Claim page cannot contain traversal segments: ${page}`,
    );
  }
  const absolute = path.posix.normalize(`/${slashed.replace(/^\/+/, "")}`);
  if (!absolute.startsWith("/openwiki/") || !absolute.endsWith(".md")) {
    throw new ClaimSessionError(
      `Claim page must be a Markdown file below /openwiki: ${page}`,
    );
  }
  if (!isGroundedWikiPage(absolute)) {
    throw new ClaimSessionError(
      `Claim page is reserved or structural: ${page}`,
    );
  }
  return absolute;
}

/**
 * Canonicalizes a model-supplied page with an optional wiki-root prefix.
 *
 * @param page - Agent-supplied canonical, repository-relative, or wiki-relative path.
 * @returns Canonical `/openwiki/...md` path for internal Claims APIs.
 */
export function normalizeClaimsToolPagePath(page: string): string {
  return normalizeWikiPagePath(normalizeWikiToolPagePath(page));
}

/**
 * Canonicalizes a model-supplied generated Markdown path.
 *
 * Unlike {@link normalizeClaimsToolPagePath}, this permits structural generated
 * pages that do not own Claims. Claims implementation files remain unavailable.
 *
 * @param page - Agent-supplied canonical, repository-relative, or wiki-relative path.
 * @returns Canonical `/openwiki/...md` path for a generated Markdown file.
 */
export function normalizeWikiToolPagePath(page: string): string {
  const slashed = page.trim().replace(/\\/gu, "/");
  if (hasTraversalSegment(slashed)) {
    throw new ClaimSessionError(
      `Wiki page cannot contain traversal segments: ${page}`,
    );
  }
  const unrooted = slashed.replace(/^\/+/, "");
  const rooted =
    unrooted === "openwiki" || unrooted.startsWith("openwiki/")
      ? unrooted
      : `openwiki/${unrooted}`;
  const normalized = path.posix.normalize(`/${rooted}`);
  const segments = normalized.toLowerCase().split("/");
  if (
    !normalized.startsWith("/openwiki/") ||
    !normalized.endsWith(".md") ||
    segments.includes(CLAIMS_DIRECTORY)
  ) {
    throw new ClaimSessionError(
      `Wiki page must be a Markdown file below /openwiki: ${page}`,
    );
  }
  return normalized;
}

/**
 * Determines whether a virtual Markdown path owns code-brain claim state.
 *
 * @param page - Canonical or candidate virtual page path.
 * @returns Whether the page receives a `.claims` sidecar.
 */
export function isGroundedWikiPage(page: string): boolean {
  const slashed = page.replace(/\\/gu, "/");
  if (hasTraversalSegment(slashed)) {
    return false;
  }
  const normalized = path.posix.normalize(`/${slashed.replace(/^\/+/, "")}`);
  const normalizedLower = normalized.toLowerCase();
  const basename = path.posix.basename(normalizedLower);
  const segments = normalizedLower.split("/");
  return (
    normalized.startsWith("/openwiki/") &&
    normalized.endsWith(".md") &&
    !segments.includes(CLAIMS_DIRECTORY) &&
    !RESERVED_WIKI_FILES.has(basename)
  );
}

/**
 * Determines whether a path uses dot-segment aliases.
 *
 * @param filePath - Slash-normalized candidate path.
 * @returns Whether the path contains `.` or `..` segments.
 */
function hasTraversalSegment(filePath: string): boolean {
  return filePath
    .split("/")
    .some((segment) => segment === "." || segment === "..");
}

/**
 * Converts a virtual generated-page path into its repository-relative path.
 *
 * @param page - Canonical virtual page path.
 * @returns Repository-relative POSIX path beginning with `openwiki/`.
 */
export function toRepositoryPagePath(page: string): string {
  return normalizeWikiPagePath(page).replace(/^\//u, "");
}

/**
 * Converts a virtual generated-page path into its sidecar-relative path.
 *
 * @param page - Canonical virtual page path.
 * @returns Path relative to `openwiki/.claims` with a `.json` extension.
 */
export function toClaimsSidecarRelativePath(page: string): string {
  const relativePage = normalizeWikiPagePath(page).slice("/openwiki/".length);
  return relativePage.replace(/\.md$/u, ".json");
}
