import { normalizeClaimsToolPagePath } from "../claims/brains/code/paths.js";
import { assertPageProse } from "../claims/brains/code/prose.js";
import type {
  PageSection,
  ProseBinding,
} from "../claims/brains/code/prose-types.js";
import {
  parseMarkdownSections,
  type MarkdownSection,
} from "../claims/brains/code/sections.js";
import { ClaimsStore } from "../claims/brains/code/store.js";
import {
  ClaimSessionError,
  ClaimsPageMissingError,
} from "../claims/core/errors.js";
import type { Claim } from "../claims/core/types.js";
import { readFrontmatterField } from "../okf/frontmatter.js";
import type {
  WikiOrientation,
  WikiOutline,
  WikiPageSummary,
  WikiRead,
} from "./types.js";

/**
 * Expected retrieval failure with actionable feedback for the calling agent.
 */
export class WikiRetrievalError extends Error {
  /**
   * Creates a retrieval error without exposing raw filesystem or sidecar data.
   *
   * @param message - Feedback describing how the agent can proceed.
   */
  constructor(message: string) {
    super(message);
    this.name = "WikiRetrievalError";
  }
}

/**
 * Validated page snapshot shared by outline and selective reading.
 */
interface LinkedWikiPage {
  /**
   * Wiki-relative Markdown path.
   */
  page: string;

  /**
   * Complete Markdown used to read authored frontmatter.
   */
  markdown: string;

  /**
   * Parsed structure joined to stable metadata in document order.
   */
  sections: Array<MarkdownSection & PageSection>;

  /**
   * Validated passage connections owned by this snapshot.
   */
  bindings: ProseBinding[];

  /**
   * Persisted claims referenced by the page's bindings.
   */
  claims: Claim[];
}

/**
 * Reads the fixed repository overview and page directory without a model or run.
 *
 * @param root - Absolute repository root containing an OpenWiki directory.
 * @returns Consolidated repository navigation.
 */
export async function orientWiki(root: string): Promise<WikiOrientation> {
  const store = new ClaimsStore(root);
  const quickstart = await readMarkdown(store, "/openwiki/quickstart.md");
  const overview = parseMarkdownSections(
    "/openwiki/quickstart.md",
    quickstart,
  )[0]?.body.trim();
  if (!overview) {
    throw new WikiRetrievalError(
      "quickstart.md has no opening repository summary. Update its introductory prose before the next heading, then retry openwiki_orient.",
    );
  }
  const pages = await Promise.all(
    (await store.discoverPages()).map(async (page) =>
      summarizePage(
        page.slice("/openwiki/".length),
        page === "/openwiki/quickstart.md"
          ? quickstart
          : await readMarkdown(store, page),
      ),
    ),
  );
  return { overview, pages };
}

/**
 * Reads a page's headings and authored descriptions using durable section IDs.
 *
 * @param root - Absolute repository root.
 * @param page - Wiki-relative Markdown path.
 * @returns Consolidated page navigation in document order.
 */
export async function outlineWiki(
  root: string,
  page: string,
): Promise<WikiOutline> {
  const linked = await loadLinkedPage(root, page);
  return {
    ...summarizePage(linked.page, linked.markdown),
    sections: linked.sections.map(({ id, location, title, description }) => ({
      id,
      location,
      title,
      description,
    })),
  };
}

/**
 * Reads selected sections, descendants, and only their connected claims.
 *
 * @param root - Absolute repository root.
 * @param page - Wiki-relative Markdown path.
 * @param sectionIds - Stable section selectors; omit to read the whole page.
 * @returns Consolidated prose, bindings, and source resources without duplication.
 */
export async function readWiki(
  root: string,
  page: string,
  sectionIds?: readonly string[],
): Promise<WikiRead> {
  const linked = await loadLinkedPage(root, page);
  const knownIds = new Set(linked.sections.map(({ id }) => id));
  const unknownIds = [...new Set(sectionIds)].filter((id) => !knownIds.has(id));
  if (sectionIds?.length === 0 || unknownIds.length) {
    const reason = unknownIds.length
      ? `Unknown section IDs: ${unknownIds.join(", ")}.`
      : "Section selection cannot be empty; omit sections to read the whole page.";
    throw new WikiRetrievalError(
      `${reason} Call openwiki_outline for ${linked.page} to discover its section IDs.`,
    );
  }
  const selected = linked.sections.filter(({ id }) => sectionIds?.includes(id));
  const sections = linked.sections.filter(
    (section) =>
      sectionIds === undefined ||
      selected.some(
        (parent) =>
          parent.id === section.id ||
          (parent.depth > 0 &&
            section.location.startsWith(`${parent.location}#`)),
      ),
  );
  const includedIds = new Set(sections.map(({ id }) => id));
  const bindings = linked.bindings.filter(({ sectionId }) =>
    includedIds.has(sectionId),
  );
  const claimIds = new Set(bindings.flatMap((binding) => binding.claimIds));
  return {
    page: linked.page,
    sections: sections.map(({ id, location, heading, body }) => ({
      id,
      location,
      content: heading + body,
    })),
    bindings,
    claims: linked.claims
      .filter(({ id }) => claimIds.has(id))
      .map(({ id, statement, evidence }) => ({
        id,
        statement,
        evidence: evidence.map(({ resource }) => ({ resource })),
      })),
  };
}

/**
 * Loads a page and checks its maintained relationships against the current prose.
 *
 * @param root - Absolute repository root.
 * @param page - Wiki-relative Markdown path.
 * @returns A validated snapshot with stable section identities.
 */
async function loadLinkedPage(
  root: string,
  page: string,
): Promise<LinkedWikiPage> {
  let canonical: string;
  try {
    canonical = normalizeClaimsToolPagePath(page);
  } catch (error) {
    if (!(error instanceof ClaimSessionError)) throw error;
    throw new WikiRetrievalError(
      "Use a factual Markdown page path returned by openwiki_orient, relative to openwiki/ and without traversal segments.",
    );
  }
  const store = new ClaimsStore(root);
  const markdown = await readMarkdown(store, canonical);
  const state = await store.loadPage(canonical);
  const relativePage = canonical.slice("/openwiki/".length);
  if (!state?.sections || !state.bindings) {
    throw new WikiRetrievalError(
      `${relativePage} has no complete section and binding metadata. Include this page in an OpenWiki update to establish its links, then retry retrieval.`,
    );
  }
  const { sections, bindings, claims } = state;
  try {
    assertPageProse(canonical, markdown, { sections, bindings }, claims);
  } catch (error) {
    if (!(error instanceof ClaimSessionError)) throw error;
    throw new WikiRetrievalError(
      `${relativePage} has section or binding metadata that no longer matches its Markdown. Include this page in an OpenWiki update to reconcile its links, then retry retrieval.`,
    );
  }
  const metadata = new Map(
    sections.map((section) => [section.location, section]),
  );
  return {
    page: relativePage,
    markdown,
    sections: parseMarkdownSections(canonical, markdown).map((section) => ({
      ...section,
      ...metadata.get(section.location)!,
    })),
    bindings,
    claims,
  };
}

/**
 * Reads a factual page through the existing filesystem containment boundary.
 *
 * @param store - Repository-local claims and prose store.
 * @param page - Canonical generated-page path.
 * @returns Complete Markdown or actionable missing-page feedback.
 */
async function readMarkdown(store: ClaimsStore, page: string): Promise<string> {
  try {
    return await store.readMarkdown(page);
  } catch (error) {
    if (!(error instanceof ClaimsPageMissingError)) throw error;
    throw new WikiRetrievalError(
      `${page.slice("/openwiki/".length)} is missing. Initialize OpenWiki if the repository has no wiki; otherwise use openwiki_orient to find available pages or update the wiki to restore the page.`,
    );
  }
}

/**
 * Extracts authored page navigation without synthesizing or caching summaries.
 *
 * @param page - Wiki-relative Markdown path.
 * @param markdown - Complete page with OKF frontmatter.
 * @returns Page metadata suitable for orient and outline.
 */
function summarizePage(page: string, markdown: string): WikiPageSummary {
  const title = readFrontmatterField(markdown, "title");
  const description = readFrontmatterField(markdown, "description");
  if (!title?.trim() || !description?.trim()) {
    throw new WikiRetrievalError(
      `${page} needs a non-empty title and description in its OKF frontmatter. Include the page in an OpenWiki update to author its navigation metadata, then retry retrieval.`,
    );
  }
  return { page, title, description };
}
