/**
 * The known-typed subset of frontmatter OpenWiki writes at the top of each page.
 */
export interface WikiMeta {
  /**
   * The page's declared kind, e.g. "Reference" or "Section".
   *
   * @default undefined - a node falls back to "Section" for index pages, else "Reference".
   */
  type?: string;

  /**
   * Explicit page title.
   *
   * @default undefined - a node falls back to the section name (index), first H1, then the filename.
   */
  title?: string;

  /**
   * One-line page summary.
   *
   * @default undefined - the node's description becomes "".
   */
  description?: string;

  /**
   * Topic tags for the page.
   *
   * @default undefined - the node's tags become an empty array.
   */
  tags?: string[];
}

/**
 * A single wiki page, as one node in the graph.
 */
export interface WikiNode {
  /**
   * Stable id: the page path relative to the wiki root, without the .md suffix.
   */
  id: string;

  /**
   * Display title, resolved from frontmatter, first heading, or filename.
   */
  title: string;

  /**
   * Page kind, used for node coloring and the legend.
   */
  type: string;

  /**
   * One-line summary, or "" when the page declares none.
   */
  description: string;

  /**
   * Topic tags, or an empty array when the page declares none.
   */
  tags: string[];

  /**
   * Raw markdown body with frontmatter stripped.
   */
  body: string;

  /**
   * Body length in characters, used to scale the node's rendered radius.
   */
  size: number;

  /**
   * Ids of pages this page links to (outgoing edges).
   */
  links: string[];

  /**
   * Ids of pages that link to this page (incoming edges).
   */
  backlinks: string[];
}

/**
 * A directed link from one page to another.
 */
export interface WikiEdge {
  /**
   * Id of the page the link starts from.
   */
  source: string;

  /**
   * Id of the page the link points to.
   */
  target: string;
}

/**
 * The complete in-memory graph, serialized to the browser at /api/graph.
 */
export interface WikiGraph {
  /**
   * Basename of the wiki root directory, shown in the page header.
   */
  root: string;

  /**
   * ISO-8601 timestamp of when this graph was built.
   */
  generatedAt: string;

  /**
   * All distinct node types present, sorted, for the legend.
   */
  types: string[];

  /**
   * Every page in the wiki.
   */
  nodes: WikiNode[];

  /**
   * Every resolved directed link between pages.
   */
  edges: WikiEdge[];
}
