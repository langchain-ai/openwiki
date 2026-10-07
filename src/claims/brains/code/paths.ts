import path from "node:path";
import {
  DEFAULT_REPOSITORY_WIKI_DIRECTORY,
  RepositoryWikiPathError,
  RepositoryWikiPaths,
} from "../../../repository-wiki/paths.js";
import { ClaimSessionError } from "../../core/errors.js";

/**
 * Backward-compatible path policy for unconfigured repository wikis.
 */
const DEFAULT_CLAIMS_WIKI_PATHS = new RepositoryWikiPaths(
  DEFAULT_REPOSITORY_WIKI_DIRECTORY,
);

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
 * Canonicalizes an actual generated-page path.
 *
 * @param page - Agent-supplied page path.
 * @param wikiPaths - Physical repository wiki path policy.
 * @returns Canonical actual Markdown path.
 */
export function normalizeWikiPagePath(
  page: string,
  wikiPaths: RepositoryWikiPaths = DEFAULT_CLAIMS_WIKI_PATHS,
): string {
  const canonical = normalizeActualWikiPagePath(page, wikiPaths, "Claim");
  if (!isGroundedCanonicalWikiPage(canonical, wikiPaths)) {
    throw new ClaimSessionError(
      `Claim page is reserved or structural: ${page}`,
    );
  }
  return canonical;
}

/**
 * Canonicalizes a model-supplied page with an optional wiki-root prefix.
 *
 * @param page - Agent-supplied canonical, repository-relative, or wiki-relative path.
 * @param wikiPaths - Physical repository wiki path policy.
 * @returns Canonical actual Markdown path for internal Claims APIs.
 */
export function normalizeClaimsToolPagePath(
  page: string,
  wikiPaths: RepositoryWikiPaths = DEFAULT_CLAIMS_WIKI_PATHS,
): string {
  return normalizeWikiPagePath(
    normalizeWikiToolPagePath(page, wikiPaths),
    wikiPaths,
  );
}

/**
 * Canonicalizes a model-supplied generated Markdown path.
 *
 * Unlike {@link normalizeClaimsToolPagePath}, this permits structural generated
 * pages that do not own Claims. Claims implementation files remain unavailable.
 *
 * @param page - Agent-supplied canonical, repository-relative, or wiki-relative path.
 * @param wikiPaths - Physical repository wiki path policy.
 * @returns Canonical actual path for a generated Markdown file.
 */
export function normalizeWikiToolPagePath(
  page: string,
  wikiPaths: RepositoryWikiPaths = DEFAULT_CLAIMS_WIKI_PATHS,
): string {
  const slashed = page.trim().replace(/\\/gu, "/").replace(/\/+/gu, "/");
  if (hasTraversalSegment(slashed)) {
    throw new ClaimSessionError(
      `Wiki page cannot contain traversal segments: ${page}`,
    );
  }
  let canonical: string;
  try {
    const unrooted = slashed.replace(/^\/+/, "");
    const namesConfiguredRoot =
      unrooted === wikiPaths.directory ||
      unrooted.startsWith(`${wikiPaths.directory}/`);
    const namesDefaultRoot =
      unrooted === DEFAULT_REPOSITORY_WIKI_DIRECTORY ||
      unrooted.startsWith(`${DEFAULT_REPOSITORY_WIKI_DIRECTORY}/`);
    canonical = wikiPaths.normalizePage(
      slashed.startsWith("/") && !namesConfiguredRoot && !namesDefaultRoot
        ? unrooted
        : slashed,
    );
  } catch (error) {
    if (!(error instanceof RepositoryWikiPathError)) throw error;
    throw new ClaimSessionError(
      `Wiki page must be a Markdown file below ${wikiPaths.canonicalRoot}: ${page}`,
    );
  }
  const segments = wikiPaths
    .toWikiRelativePage(canonical)
    .toLowerCase()
    .split("/");
  if (segments.includes(CLAIMS_DIRECTORY)) {
    throw new ClaimSessionError(
      `Wiki page must be a Markdown file below ${wikiPaths.canonicalRoot}: ${page}`,
    );
  }
  return canonical;
}

/**
 * Determines whether an actual Markdown path owns code-brain claim state.
 *
 * @param page - Canonical or candidate actual page path.
 * @param wikiPaths - Physical repository wiki path policy.
 * @returns Whether the page receives a `.claims` sidecar.
 */
export function isGroundedWikiPage(
  page: string,
  wikiPaths: RepositoryWikiPaths = DEFAULT_CLAIMS_WIKI_PATHS,
): boolean {
  try {
    return isGroundedCanonicalWikiPage(
      normalizeActualWikiPagePath(page, wikiPaths, "Claim"),
      wikiPaths,
    );
  } catch {
    return false;
  }
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
 * Converts an actual generated-page path into its repository-relative path.
 *
 * @param page - Canonical actual page path.
 * @param wikiPaths - Physical repository wiki path policy.
 * @returns Repository-relative POSIX path beginning with the configured root.
 */
export function toRepositoryPagePath(
  page: string,
  wikiPaths: RepositoryWikiPaths = DEFAULT_CLAIMS_WIKI_PATHS,
): string {
  return wikiPaths.toRepositoryPage(normalizeWikiPagePath(page, wikiPaths));
}

/**
 * Converts an actual generated-page path into its sidecar-relative path.
 *
 * @param page - Canonical actual page path.
 * @param wikiPaths - Physical repository wiki path policy.
 * @returns Path relative to the configured `.claims` directory.
 */
export function toClaimsSidecarRelativePath(
  page: string,
  wikiPaths: RepositoryWikiPaths = DEFAULT_CLAIMS_WIKI_PATHS,
): string {
  const relativePage = wikiPaths.toWikiRelativePage(
    normalizeWikiPagePath(page, wikiPaths),
  );
  return relativePage.replace(/\.md$/u, ".json");
}

/**
 * Canonicalizes a page that must already name the configured wiki root.
 */
function normalizeActualWikiPagePath(
  page: string,
  wikiPaths: RepositoryWikiPaths,
  label: string,
): string {
  const slashed = page.trim().replace(/\\/gu, "/").replace(/\/+/gu, "/");
  if (hasTraversalSegment(slashed)) {
    throw new ClaimSessionError(
      `${label} page cannot contain traversal segments: ${page}`,
    );
  }
  const unrooted = slashed.replace(/^\/+/, "");
  if (
    unrooted !== wikiPaths.directory &&
    !unrooted.startsWith(`${wikiPaths.directory}/`)
  ) {
    throw new ClaimSessionError(
      `${label} page must be a Markdown file below ${wikiPaths.canonicalRoot}: ${page}`,
    );
  }
  try {
    return wikiPaths.normalizePage(slashed);
  } catch (error) {
    if (!(error instanceof RepositoryWikiPathError)) throw error;
    throw new ClaimSessionError(
      `${label} page must be a Markdown file below ${wikiPaths.canonicalRoot}: ${page}`,
    );
  }
}

/**
 * Tests whether a canonical wiki page owns factual Claims state.
 */
function isGroundedCanonicalWikiPage(
  canonical: string,
  wikiPaths: RepositoryWikiPaths,
): boolean {
  const relative = wikiPaths.toWikiRelativePage(canonical).toLowerCase();
  const basename = path.posix.basename(relative);
  const segments = relative.split("/");
  return (
    !segments.includes(CLAIMS_DIRECTORY) && !RESERVED_WIKI_FILES.has(basename)
  );
}
