import { marked, type Token, type Tokens } from "marked";
import { ClaimsStore } from "../claims/brains/code/store.js";
import { normalizeWikiPagePath } from "../claims/brains/code/paths.js";
import { parseFrontmatterFields } from "../okf/frontmatter.js";
import {
  resolveReadableWiki,
  resolveWikiSearchScope,
  type WikiWorkspaceRequired,
  type WikiWorkspaceSummary,
} from "../linking/wiki-workspaces.js";

/**
 * Shared request and response bounds for repository wiki retrieval.
 *
 * The MCP schemas and transport-independent implementation both consume these
 * values so their validation contracts cannot drift.
 */
export const WIKI_RETRIEVAL_LIMITS = Object.freeze({
  /**
   * Maximum number of characters in a search query.
   */
  queryCharacters: 2_000,

  /**
   * Maximum number of source-path hints accepted by one search.
   */
  sourcePathHints: 20,

  /**
   * Maximum number of characters in one source-path hint.
   */
  sourcePathCharacters: 500,

  /**
   * Maximum number of ranked results returned by one search.
   */
  searchResults: 20,

  /**
   * Default number of ranked results returned by one search.
   */
  defaultSearchResults: 5,

  /**
   * Maximum number of characters in one wiki page path.
   */
  pageCharacters: 1_000,

  /**
   * Maximum number of section anchors accepted by one read.
   */
  sectionAnchors: 20,

  /**
   * Maximum number of characters in one section anchor.
   */
  sectionAnchorCharacters: 500,

  /**
   * Maximum number of characters in a compact search excerpt.
   */
  excerptCharacters: 600,

  /**
   * Maximum number of distinct terms retained from one query.
   */
  queryTerms: 64,

  /**
   * Maximum number of characters in one linked wiki identity.
   */
  wikiIdCharacters: 64,

  /**
   * Maximum number of characters in a workspace ID or display name.
   */
  workspaceReferenceCharacters: 80,
});

/**
 * Low-signal English terms omitted when a query has more specific words.
 */
const STOP_WORDS = new Set(
  "a an and are as at be by can do does for from how i in is it of on or our that the their this to was we what when where which why with your".split(
    " ",
  ),
);

/**
 * Stable correction guidance for pages outside the public retrieval surface.
 */
const INVALID_WIKI_PAGE_MESSAGE =
  "Page must be a non-structural Markdown path below openwiki/.";

/**
 * Search controls shared by direct callers and the MCP adapter.
 */
export interface WikiSearchRequest {
  /**
   * Natural-language repository question, behavior, or concept.
   */
  query: string;

  /**
   * Optional repository-relative source paths used as ranking hints.
   */
  paths?: readonly string[];

  /**
   * Optional bounded result count.
   */
  limit?: number;

  /**
   * Optional explicit workspace ID or unique name overriding automatic scope.
   */
  workspace?: string;
}

/**
 * One compact search hit whose refs can be passed to
 * {@link readWikiSections}.
 */
export interface WikiSearchResult {
  /**
   * Stable result category reserved for future retrieval kinds.
   */
  kind: "section";

  /**
   * Exact page-and-heading references suitable for `openwiki_read`.
   */
  ref: string[];

  /**
   * Compact orientation text rather than the complete section body.
   */
  content: string;

  /**
   * Linked wiki identity to pass to `openwiki_read`.
   *
   * Omitted when the repository is not part of a linked wiki set.
   */
  wiki?: string;
}

/**
 * One wiki identity searched as part of a linked repository set.
 */
export interface WikiSearchIdentity {
  /**
   * Stable identity accepted by `openwiki_read`.
   */
  id: string;

  /**
   * Human-readable repository name.
   */
  name: string;
}

/**
 * Successful model-free repository wiki search response.
 */
export interface WikiSearchResults {
  /**
   * Ranked compact results in descending relevance order.
   */
  results: WikiSearchResult[];

  /**
   * Selected named workspace, omitted for a standalone wiki.
   */
  workspace?: WikiWorkspaceSummary;

  /**
   * Complete linked wiki inventory searched by this call.
   *
   * Omitted for an ordinary unlinked repository.
   */
  wikis?: WikiSearchIdentity[];
}

/**
 * Complete search response, including structured workspace ambiguity.
 */
export type WikiSearchResponse = WikiSearchResults | WikiWorkspaceRequired;

/**
 * Exact section selection from one search result page.
 */
export interface WikiReadRequest {
  /**
   * Repository-relative wiki page returned by search.
   */
  page: string;

  /**
   * Exact heading anchors returned by search, in desired read order.
   */
  sections: readonly string[];

  /**
   * Linked wiki identity returned by search.
   *
   * Omitted to read the repository where retrieval began.
   */
  wiki?: string;
}

/**
 * One complete Markdown section returned by a wiki read.
 */
export interface WikiReadSection {
  /**
   * Exact normalized heading anchor.
   */
  section: string;

  /**
   * Complete heading and body, including descendant sections.
   */
  content: string;
}

/**
 * Complete selected sections in request order.
 */
export interface WikiReadResponse {
  /**
   * Normalized repository-relative wiki page.
   */
  page: string;

  /**
   * Complete selected sections in the caller's requested order.
   */
  sections: WikiReadSection[];

  /**
   * Linked wiki identity that supplied the page.
   *
   * Omitted when the repository is not linked.
   */
  wiki?: string;
}

/**
 * Expected, caller-correctable retrieval failure.
 */
export class WikiRetrievalError extends Error {
  /**
   * Creates a bounded retrieval error safe to return through the host adapter.
   *
   * @param message - Stable correction guidance for the caller.
   */
  constructor(message: string) {
    super(message);
    this.name = "WikiRetrievalError";
  }
}

/**
 * Searchable representation of one authored wiki section.
 */
interface SearchUnit {
  /**
   * Exact repository-relative page-and-heading reference.
   */
  ref: string;

  /**
   * Human-readable page title.
   */
  title: string;

  /**
   * Human-readable page description shown in compact results.
   */
  description: string;

  /**
   * Section heading, or an empty string for a page-level fallback.
   */
  heading: string;

  /**
   * Searchable introduction and section Markdown.
   */
  prose: string;

  /**
   * Searchable page path, tags, and source resources.
   */
  identifiers: string;

  /**
   * Normalized repository source paths used for ranking boosts.
   */
  sourcePaths: string[];

  /**
   * Compact relevant block shown before a full read.
   */
  excerpt: string;

  /**
   * Identity of the repository wiki that supplied this section.
   */
  wiki: string;
}

/**
 * Page-level values shared by every searchable section on one wiki page.
 */
interface SearchPageContext {
  /**
   * Repository-relative wiki page path.
   */
  relativePage: string;

  /**
   * Human-readable page title.
   */
  title: string;

  /**
   * Human-readable page description.
   */
  description: string;

  /**
   * Searchable page path, tags, and source resources.
   */
  identifiers: string;

  /**
   * Normalized repository source paths used for ranking boosts.
   */
  sourcePaths: string[];

  /**
   * Introductory prose inherited by each section.
   */
  introduction: string;

  /**
   * Normalized query terms used to choose the compact excerpt.
   */
  terms: readonly string[];
}

/**
 * One parsed Markdown heading and its complete descendant-bounded section.
 */
interface ParsedHeadingSection {
  /**
   * GitHub-compatible heading anchor, including duplicate suffixes.
   */
  anchor: string;

  /**
   * Markdown heading depth.
   */
  depth: number;

  /**
   * Human-readable heading text.
   */
  heading: string;

  /**
   * Complete raw Markdown for the heading and its descendants.
   */
  raw: string;
}

/**
 * One parsed heading plus its token-array location.
 */
interface LocatedHeading {
  /**
   * GitHub-compatible heading anchor, including duplicate suffixes.
   */
  anchor: string;

  /**
   * Markdown heading depth.
   */
  depth: number;

  /**
   * Human-readable heading text.
   */
  heading: string;

  /**
   * Heading token index in the parsed page body.
   */
  index: number;
}

/**
 * One FTS result row ordered by SQLite's BM25 score.
 */
type RankedSearchRow = {
  /**
   * One-based row identifier matching the search-unit array.
   */
  rowid: number | bigint;

  /**
   * SQLite BM25 relevance score.
   */
  score: number;
};

/**
 * Searches authored wiki sections with a checkout-local, in-memory FTS index.
 * Search returns compact orientation; exact prose is retrieved separately.
 *
 * @param root - Canonical absolute Git repository root.
 * @param request - Validated query, source hints, and result limit.
 * @returns Ranked compact section references.
 * @throws {WikiRetrievalError} When request values are invalid.
 */
export async function searchWiki(
  root: string,
  request: WikiSearchRequest,
): Promise<WikiSearchResponse> {
  const query = request.query.trim();
  const limit = request.limit ?? WIKI_RETRIEVAL_LIMITS.defaultSearchResults;
  if (!query || query.length > WIKI_RETRIEVAL_LIMITS.queryCharacters) {
    throw new WikiRetrievalError(
      `Use a non-empty search query of at most ${WIKI_RETRIEVAL_LIMITS.queryCharacters} characters.`,
    );
  }
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > WIKI_RETRIEVAL_LIMITS.searchResults
  ) {
    throw new WikiRetrievalError(
      `Search limit must be an integer from 1 to ${WIKI_RETRIEVAL_LIMITS.searchResults}.`,
    );
  }

  const paths = (request.paths ?? []).map(normalizeRepositoryPathHint);
  if (paths.length > WIKI_RETRIEVAL_LIMITS.sourcePathHints) {
    throw new WikiRetrievalError(
      `Search accepts at most ${WIKI_RETRIEVAL_LIMITS.sourcePathHints} source path hints.`,
    );
  }
  if (
    request.workspace !== undefined &&
    (!request.workspace.trim() ||
      request.workspace.length >
        WIKI_RETRIEVAL_LIMITS.workspaceReferenceCharacters)
  ) {
    throw new WikiRetrievalError(
      "Use a valid workspace ID or name returned by openwiki_list_workspaces.",
    );
  }

  const scope = await resolveWikiSearchScope(root, request.workspace?.trim());
  if (scope.status === "workspace_required") return scope;
  const terms = queryTerms(query);
  if (!terms.length) {
    return scope.workspace
      ? {
          results: [],
          workspace: scope.workspace,
          wikis: scope.wikis.map(wikiIdentity),
        }
      : { results: [] };
  }

  const units: SearchUnit[] = [];
  for (const wiki of scope.wikis) {
    const store = new ClaimsStore(wiki.root);
    for (const page of await store.discoverPages()) {
      if (!isRetrievableWikiPage(page)) continue;
      const markdown = await store.readMarkdown(page);
      units.push(...searchUnits(markdown, page, terms, wiki.id));
    }
  }
  if (!units.length) {
    return scope.workspace
      ? {
          results: [],
          workspace: scope.workspace,
          wikis: scope.wikis.map(wikiIdentity),
        }
      : { results: [] };
  }

  const response = await rankSearchUnits(
    units,
    terms,
    paths,
    limit,
    scope.workspace !== undefined,
  );
  return scope.workspace
    ? {
        ...response,
        workspace: scope.workspace,
        wikis: scope.wikis.map(wikiIdentity),
      }
    : response;
}

/**
 * Ranks searchable wiki sections with a checkout-local FTS5 index.
 *
 * The index lives only for this call, so it cannot outlive the Markdown that
 * produced it. Query terms are normalized words and remain bound SQL data.
 *
 * @param units - Searchable page sections.
 * @param terms - Normalized query terms.
 * @param paths - Normalized repository source hints.
 * @param limit - Maximum number of results to return.
 * @param includeWiki - Whether public results need linked wiki identities.
 * @returns Ranked compact section results.
 */
async function rankSearchUnits(
  units: SearchUnit[],
  terms: readonly string[],
  paths: readonly string[],
  limit: number,
  includeWiki: boolean,
): Promise<WikiSearchResults> {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(
      "CREATE VIRTUAL TABLE units USING fts5(title, description, heading, prose, identifiers, tokenize='porter unicode61')",
    );
    const insert = database.prepare(
      "INSERT INTO units(rowid, title, description, heading, prose, identifiers) VALUES (?, ?, ?, ?, ?, ?)",
    );
    units.forEach((unit, index) =>
      insert.run(
        index + 1,
        normalizeSearchText(unit.title),
        normalizeSearchText(unit.description),
        normalizeSearchText(unit.heading),
        normalizeSearchText(unit.prose),
        normalizeSearchText(unit.identifiers),
      ),
    );

    // Only normalized word terms reach MATCH, and each is quoted as data.
    const match = terms.map((term) => `"${term}"`).join(" OR ");
    const ranked = database
      .prepare(
        "SELECT rowid, bm25(units, 8, 4, 6, 1, 3) AS score FROM units WHERE units MATCH ? ORDER BY score, rowid",
      )
      .all(match) as RankedSearchRow[];
    const matchingRows = database.prepare(
      "SELECT rowid FROM units WHERE units MATCH ?",
    );
    const coverage = new Map<number, number>();
    for (const term of terms) {
      for (const row of matchingRows.all(`"${term}"`)) {
        const rowid = Number(row.rowid);
        coverage.set(rowid, (coverage.get(rowid) ?? 0) + 1);
      }
    }
    const pathScores = units.map((unit) => pathMatchCount(unit, paths));

    ranked.sort((left, right) => {
      const leftId = Number(left.rowid);
      const rightId = Number(right.rowid);
      return (
        pathScores[rightId - 1] - pathScores[leftId - 1] ||
        (coverage.get(rightId) ?? 0) - (coverage.get(leftId) ?? 0) ||
        left.score - right.score ||
        leftId - rightId
      );
    });

    return {
      results: ranked
        .slice(0, limit)
        .map(({ rowid }) =>
          renderSearchResult(units[Number(rowid) - 1], includeWiki),
        ),
    };
  } finally {
    database.close();
  }
}

/**
 * Renders one ranked unit as a compact progressive-disclosure result.
 *
 * @param unit - Ranked searchable section.
 * @param includeWiki - Whether to expose the supplying linked wiki.
 * @returns Public search result containing a read-compatible reference.
 */
function renderSearchResult(
  unit: SearchUnit,
  includeWiki: boolean,
): WikiSearchResult {
  const heading = unit.heading ? `Section: ${unit.heading}` : "";
  const result: WikiSearchResult = {
    kind: "section",
    ref: [unit.ref],
    content: [unit.title, heading, unit.description, unit.excerpt]
      .filter(Boolean)
      .join("\n"),
  };
  if (includeWiki) result.wiki = unit.wiki;
  return result;
}

/**
 * Reads complete heading sections selected from an `openwiki_search` result.
 *
 * @param root - Canonical absolute Git repository root.
 * @param request - Wiki page and exact heading anchors to read.
 * @returns Complete selected sections in request order.
 * @throws {WikiRetrievalError} When the page or section selection is invalid.
 */
export async function readWikiSections(
  root: string,
  request: WikiReadRequest,
): Promise<WikiReadResponse> {
  if (!request.sections.length) {
    throw new WikiRetrievalError("Provide at least one section anchor.");
  }
  if (request.sections.length > WIKI_RETRIEVAL_LIMITS.sectionAnchors) {
    throw new WikiRetrievalError(
      `Read accepts at most ${WIKI_RETRIEVAL_LIMITS.sectionAnchors} section anchors.`,
    );
  }

  if (
    request.wiki !== undefined &&
    (!request.wiki.trim() ||
      request.wiki.length > WIKI_RETRIEVAL_LIMITS.wikiIdCharacters)
  ) {
    throw new WikiRetrievalError(
      "Use a valid linked wiki ID returned by search.",
    );
  }

  const selectedWiki = await resolveReadableWiki(root, request.wiki?.trim());

  const normalizedPage = normalizeRetrievableWikiPage(request.page);
  const requested = request.sections.map(normalizeSectionAnchor);
  const markdown = await new ClaimsStore(selectedWiki.root).readMarkdown(
    normalizedPage,
  );
  const body = markdownBody(markdown);
  const tokens = marked.lexer(body);
  const available = new Map(
    headingSections(tokens).map((section) => [section.anchor, section.raw]),
  );
  const missing = requested.filter((section) => !available.has(section));
  if (missing.length) {
    throw new WikiRetrievalError(
      `Unknown section${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
    );
  }

  const response: WikiReadResponse = {
    page: normalizedPage.slice(1),
    sections: requested.map((section) => ({
      section,
      content: available.get(section) as string,
    })),
  };
  if (request.wiki !== undefined) response.wiki = selectedWiki.id;
  return response;
}

/**
 * Removes a validated repository root from one public search identity.
 *
 * @param wiki - Resolved repository wiki.
 * @returns Client-facing stable ID and name.
 */
function wikiIdentity(wiki: WikiSearchIdentity): WikiSearchIdentity {
  return { id: wiki.id, name: wiki.name };
}

/**
 * Converts one authored wiki page into independently searchable sections.
 *
 * @param markdown - Complete wiki page Markdown.
 * @param page - Canonical virtual page path.
 * @param terms - Normalized query terms used for excerpt selection.
 * @param wiki - Identity of the repository wiki supplying the page.
 * @returns Searchable H2 sections, or a page-level H1 fallback.
 */
function searchUnits(
  markdown: string,
  page: string,
  terms: readonly string[],
  wiki: string,
): SearchUnit[] {
  const fields = parseFrontmatterFields(markdown) ?? {};
  if (fields.status === "deprecated") return [];
  const body = markdownBody(markdown);
  if (!body) return [];

  const relativePage = page.slice(1);
  const title = stringField(fields.title) ?? relativePage;
  const description = stringField(fields.description) ?? "";
  const tags = stringArray(fields.tags);
  const sourcePaths = sourceResources(fields).map(repositoryPathFromResource);
  const tokens = marked.lexer(body);
  const headings = headingSections(tokens);
  const sections = headings.filter(
    ({ depth, heading }) =>
      depth === 2 &&
      !/^(related (pages|reading|links)|see also|navigation)$/iu.test(
        heading.trim(),
      ),
  );
  const firstH1 = headings.find(({ depth }) => depth === 1);
  const introduction = tokens
    .slice(0, firstLevelTwoIndex(tokens))
    .filter((token) => token.type !== "heading")
    .map((token) => token.raw)
    .join("");

  const context: SearchPageContext = {
    relativePage,
    title,
    description,
    identifiers: [relativePage, ...tags, ...sourcePaths].join(" "),
    sourcePaths,
    introduction,
    terms,
  };

  if (sections.length) {
    return sections.map((section) => createSearchUnit(section, context, wiki));
  }
  if (firstH1) {
    return [createSearchUnit({ ...firstH1, raw: body }, context, wiki)];
  }
  return [];
}

/**
 * Creates one searchable unit from a parsed heading and page-level context.
 *
 * @param section - Parsed heading section.
 * @param context - Metadata and introductory prose shared by the page.
 * @param wiki - Identity of the repository wiki supplying the section.
 * @returns Searchable section representation.
 */
function createSearchUnit(
  section: ParsedHeadingSection,
  context: SearchPageContext,
  wiki: string,
): SearchUnit {
  return {
    ref: `${context.relativePage}#${section.anchor}`,
    title: context.title,
    description: context.description,
    heading: section.depth === 1 ? "" : section.heading,
    prose: `${context.introduction}\n${section.raw}`,
    identifiers: context.identifiers,
    sourcePaths: context.sourcePaths,
    excerpt: relevantExcerpt(section.raw, context.terms),
    wiki,
  };
}

/**
 * Parses every heading using duplicate anchors compatible with GitHub slugs.
 *
 * @param tokens - Tokenized Markdown page body.
 * @returns Parsed headings with descendant-bounded raw Markdown.
 */
function headingSections(tokens: Token[]): ParsedHeadingSection[] {
  const headings: LocatedHeading[] = [];
  const slugs = new Map<string, number>();
  for (const [index, token] of tokens.entries()) {
    if (token.type !== "heading") continue;
    const heading = token as Tokens.Heading;
    const base = headingSlug(heading);
    const count = slugs.get(base) ?? 0;
    slugs.set(base, count + 1);
    headings.push({
      anchor: count ? `${base}-${count}` : base,
      depth: heading.depth,
      heading: heading.text,
      index,
    });
  }
  return headings.map((heading) => {
    let end = heading.index + 1;
    while (end < tokens.length) {
      const next = tokens[end];
      if (
        next?.type === "heading" &&
        (next as Tokens.Heading).depth <= heading.depth
      ) {
        break;
      }
      end += 1;
    }
    return {
      anchor: heading.anchor,
      depth: heading.depth,
      heading: heading.heading,
      raw: tokens
        .slice(heading.index, end)
        .map((token) => token.raw)
        .join("")
        .trim(),
    };
  });
}

/**
 * Finds the first H2 token that begins independently searchable content.
 *
 * @param tokens - Tokenized Markdown page body.
 * @returns H2 token index, or the token count when no H2 exists.
 */
function firstLevelTwoIndex(tokens: Token[]): number {
  const index = tokens.findIndex(
    (token) =>
      token.type === "heading" && (token as Tokens.Heading).depth === 2,
  );
  return index === -1 ? tokens.length : index;
}

/**
 * Selects and compacts the section block matching the most query terms.
 *
 * @param raw - Complete raw section Markdown.
 * @param terms - Normalized query terms.
 * @returns Bounded plain-text excerpt.
 */
function relevantExcerpt(raw: string, terms: readonly string[]): string {
  const blocks = marked
    .lexer(raw)
    .filter((token) => token.type !== "heading" && token.raw.trim());
  const best = blocks
    .map((block, index) => ({
      block,
      index,
      score: terms.reduce(
        (score, term) =>
          score +
          (normalizeSearchText(block.raw).toLowerCase().includes(term) ? 1 : 0),
        0,
      ),
    }))
    .sort(
      (left, right) => right.score - left.score || left.index - right.index,
    )[0]?.block.raw;
  if (!best) return "";
  const compact = best
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[`*_>#|]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (compact.length <= WIKI_RETRIEVAL_LIMITS.excerptCharacters) return compact;
  const shortened = compact.slice(
    0,
    WIKI_RETRIEVAL_LIMITS.excerptCharacters + 1,
  );
  const boundary = shortened.lastIndexOf(" ");
  return `${shortened.slice(
    0,
    boundary > 0 ? boundary : WIKI_RETRIEVAL_LIMITS.excerptCharacters,
  )}…`;
}

/**
 * Extracts distinct bounded search terms while dropping low-signal words.
 *
 * Stop words remain usable when a query contains no more specific terms.
 *
 * @param query - Validated natural-language search query.
 * @returns Normalized terms safe to quote as FTS data.
 */
function queryTerms(query: string): string[] {
  const all = [
    ...new Set(
      normalizeSearchText(query)
        .toLowerCase()
        .match(/[\p{L}\p{N}_]+/gu) ?? [],
    ),
  ].slice(0, WIKI_RETRIEVAL_LIMITS.queryTerms);
  const meaningful = all.filter((term) => !STOP_WORDS.has(term));
  return meaningful.length ? meaningful : all;
}

/**
 * Retains exact text while adding searchable camel-case and path components.
 *
 * @param text - Raw title, prose, or identifier text.
 * @returns Text containing both original and split token forms.
 */
function normalizeSearchText(text: string): string {
  return `${text} ${text
    .replace(/([\p{Ll}\d])([\p{Lu}])/gu, "$1 $2")
    .replace(/([\p{Lu}])([\p{Lu}][\p{Ll}])/gu, "$1 $2")
    .replace(/[_./:#-]+/gu, " ")}`;
}

/**
 * Validates and normalizes one repository-relative source-path hint.
 *
 * @param value - Caller-supplied source path.
 * @returns Lowercase slash-normalized path.
 * @throws {WikiRetrievalError} When the path is unsafe or malformed.
 */
function normalizeRepositoryPathHint(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  if (
    !normalized ||
    normalized.length > WIKI_RETRIEVAL_LIMITS.sourcePathCharacters ||
    normalized.startsWith("/") ||
    normalized.includes(":") ||
    normalized
      .split("/")
      .some((part) => !part || part === "." || part === "..") ||
    [...normalized].some(
      (character) => character < " " || "*?[]".includes(character),
    )
  ) {
    throw new WikiRetrievalError(
      "Source hints must be repository-relative paths without traversal or globs.",
    );
  }
  return normalized.toLowerCase();
}

/**
 * Converts one repository source URI into a normalized path for ranking.
 *
 * @param value - Frontmatter source beginning with `repo://`.
 * @returns Lowercase repository-relative source path.
 */
function repositoryPathFromResource(value: string): string {
  return value
    .replace(/^repo:\/\//u, "")
    .split("#", 1)[0]
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .toLowerCase();
}

/**
 * Normalizes a caller-supplied page to the public retrieval subset.
 *
 * @param page - Repository-relative wiki page selected from search.
 * @returns Canonical virtual page path beginning with `/openwiki/`.
 * @throws {WikiRetrievalError} When the path is structural, hidden, or unsafe.
 */
function normalizeRetrievableWikiPage(page: string): string {
  let normalized: string;
  try {
    normalized = normalizeWikiPagePath(page);
  } catch {
    throw new WikiRetrievalError(INVALID_WIKI_PAGE_MESSAGE);
  }
  if (
    page.trim().length > WIKI_RETRIEVAL_LIMITS.pageCharacters ||
    !isRetrievableWikiPage(normalized)
  ) {
    throw new WikiRetrievalError(INVALID_WIKI_PAGE_MESSAGE);
  }
  return normalized;
}

/**
 * Determines whether a canonical wiki path avoids hidden path segments.
 *
 * @param page - Canonical virtual wiki page path.
 * @returns Whether the page is part of the public retrieval surface.
 */
function isRetrievableWikiPage(page: string): boolean {
  return !page.split("/").some((segment) => segment.startsWith("."));
}

/**
 * Counts source hints associated with one searchable wiki section.
 *
 * @param unit - Searchable section.
 * @param expectedPaths - Normalized repository source hints.
 * @returns Number of exact or suffix-equivalent source-path matches.
 */
function pathMatchCount(
  unit: SearchUnit,
  expectedPaths: readonly string[],
): number {
  if (!expectedPaths.length) return 0;
  return expectedPaths.filter((expected) =>
    unit.sourcePaths.some(
      (actual) =>
        actual === expected ||
        actual.endsWith(`/${expected}`) ||
        expected.endsWith(`/${actual}`),
    ),
  ).length;
}

/**
 * Normalizes one heading anchor selected from a search reference.
 *
 * @param value - Caller-supplied heading anchor.
 * @returns Anchor without an optional leading hash.
 * @throws {WikiRetrievalError} When the anchor contains a path or control data.
 */
function normalizeSectionAnchor(value: string): string {
  const normalized = value.trim().replace(/^#/u, "");
  if (
    !normalized ||
    normalized.length > WIKI_RETRIEVAL_LIMITS.sectionAnchorCharacters ||
    normalized.includes("#") ||
    normalized.includes("/") ||
    [...normalized].some((character) => character < " ")
  ) {
    throw new WikiRetrievalError(
      "Sections must be heading anchors without a page path.",
    );
  }
  return normalized;
}

/**
 * Produces the GitHub-compatible base anchor for one Markdown heading.
 *
 * @param heading - Parsed Markdown heading.
 * @returns Lowercase anchor before duplicate suffixing.
 */
function headingSlug(heading: Tokens.Heading): string {
  return inlineHeadingText(heading.tokens)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, "")
    .replace(/ /gu, "-");
}

/**
 * Extracts visible heading text without retaining raw HTML tokens.
 *
 * @param tokens - Parsed inline heading tokens.
 * @returns Concatenated textual content used to form an anchor.
 */
function inlineHeadingText(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      if (token.type === "html") return "";
      if ("tokens" in token && Array.isArray(token.tokens)) {
        return inlineHeadingText(token.tokens);
      }
      if ("text" in token && typeof token.text === "string") {
        return token.text;
      }
      return token.type === "br" ? " " : "";
    })
    .join("");
}

/**
 * Removes optional YAML frontmatter from a complete Markdown page.
 *
 * @param markdown - Complete wiki page Markdown.
 * @returns Trimmed authored Markdown body.
 */
function markdownBody(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "").trim();
}

/**
 * Extracts repository source URIs from parsed OKF frontmatter.
 *
 * @param fields - Parsed frontmatter fields.
 * @returns Repository source URIs in authored order.
 */
function sourceResources(fields: Record<string, unknown>): string[] {
  if (!Array.isArray(fields.sources)) return [];
  return fields.sources.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const resource = (value as Record<string, unknown>).resource;
    return typeof resource === "string" && resource.startsWith("repo://")
      ? [resource]
      : [];
  });
}

/**
 * Narrows a frontmatter field to a non-empty trimmed string.
 *
 * @param value - Unknown parsed frontmatter value.
 * @returns Trimmed string, or `undefined` for any other value.
 */
function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Narrows a frontmatter field to its string array members.
 *
 * @param value - Unknown parsed frontmatter value.
 * @returns String members in their original order.
 */
function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
