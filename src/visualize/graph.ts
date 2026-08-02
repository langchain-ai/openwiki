import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

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

/**
 * A raw frontmatter map: each key is either a scalar string or a string list.
 */
type RawMeta = Record<string, string | string[]>;

/**
 * Pages that are generation scaffolding, not real wiki content.
 */
const EXCLUDED_FILES = new Set(["INSTRUCTIONS.md", "log.md", "_plan.md"]);

/**
 * Matches a relative markdown link target (`foo.md`, optionally with an `#anchor`).
 */
const MARKDOWN_LINK = /\]\(([^)\s]+\.md)(?:#[^)]*)?\)/g;

/**
 * Strip a single pair of surrounding single or double quotes.
 */
function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

/**
 * Split a markdown file's YAML frontmatter from its body. Only the small subset
 * OpenWiki emits (scalars, inline `[a, b]` arrays, and dashed lists) is parsed.
 */
export function splitFrontmatter(raw: string): { meta: RawMeta; body: string } {
  if (!raw.startsWith("---")) {
    return { meta: {}, body: raw };
  }
  const end = raw.indexOf("\n---", 3);
  if (end === -1) {
    return { meta: {}, body: raw };
  }
  const block = raw.slice(3, end).trim();
  const body = raw.slice(raw.indexOf("\n", end + 1) + 1);
  const meta: RawMeta = {};
  let pendingListKey: string | undefined;
  for (const line of block.split("\n")) {
    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && pendingListKey) {
      (meta[pendingListKey] as string[]).push(stripQuotes(listItem[1].trim()));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = rawValue.trim();
    if (value === "") {
      pendingListKey = key;
      meta[key] = [];
    } else if (value.startsWith("[") && value.endsWith("]")) {
      pendingListKey = undefined;
      meta[key] = value
        .slice(1, -1)
        .split(",")
        .map((item) => stripQuotes(item.trim()))
        .filter(Boolean);
    } else {
      pendingListKey = undefined;
      meta[key] = stripQuotes(value);
    }
  }
  return { meta, body };
}

/**
 * Read the known OpenWiki fields out of a raw frontmatter map, typed.
 */
function readMeta(raw: RawMeta): WikiMeta {
  const scalar = (value: string | string[] | undefined): string | undefined =>
    typeof value === "string" ? value : undefined;
  return {
    type: scalar(raw.type),
    title: scalar(raw.title),
    description: scalar(raw.description),
    tags: Array.isArray(raw.tags) ? raw.tags : undefined,
  };
}

/**
 * First H1 in a markdown body, or undefined when there is none.
 */
export function firstHeading(body: string): string | undefined {
  return body.match(/^#\s+(.+)$/m)?.[1].trim();
}

/**
 * Turn an absolute wiki file path into a stable node id (relative, no .md).
 */
export function toId(wikiRoot: string, fullPath: string): string {
  return path
    .relative(wikiRoot, fullPath)
    .replace(/\\/g, "/")
    .replace(/\.md$/, "");
}

/**
 * Title for an index page: its section directory name, capitalized ("Home" at the root).
 */
function sectionTitle(file: string, wikiRoot: string): string {
  const dir = path.dirname(file);
  const name = path.resolve(dir) === wikiRoot ? "Home" : path.basename(dir);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Every relative markdown link target found in a body.
 */
function markdownLinks(body: string): string[] {
  return [...body.matchAll(MARKDOWN_LINK)].map((match) => match[1]);
}

/**
 * Recursively collect markdown files under `dir`. Two guards keep the walk inside the
 * wiki: the resolved path must stay within `wikiRoot`, and only real directories and
 * files are traversed. A symlink dirent is neither `isDirectory()` nor `isFile()`, so
 * a symlink pointing outside the wiki is never followed or read.
 */
async function collectMarkdown(
  dir: string,
  wikiRoot: string,
  out: string[] = [],
): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.resolve(dir, entry.name);
    if (full !== wikiRoot && !full.startsWith(wikiRoot + path.sep)) continue;
    if (entry.isDirectory()) {
      await collectMarkdown(full, wikiRoot, out);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".md") &&
      !EXCLUDED_FILES.has(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Read one markdown file into a fully-populated but not-yet-linked graph node.
 */
async function readNode(file: string, wikiRoot: string): Promise<WikiNode> {
  const { meta: raw, body } = splitFrontmatter(await readFile(file, "utf8"));
  const meta = readMeta(raw);
  const isIndex = path.basename(file) === "index.md";
  // Index pages carry a generic "# Files" heading, so prefer the section name.
  const title =
    meta.title ??
    (isIndex ? sectionTitle(file, wikiRoot) : firstHeading(body)) ??
    path.basename(file, ".md");
  return {
    id: toId(wikiRoot, file),
    title,
    type: meta.type ?? (isIndex ? "Section" : "Reference"),
    description: meta.description ?? "",
    tags: meta.tags ?? [],
    body,
    size: body.length,
    links: [],
    backlinks: [],
  };
}

/**
 * Resolve each node's markdown links into directed edges between existing nodes,
 * recording them on the nodes' `links`/`backlinks` in place. Self-links, links to
 * unknown pages, and duplicate edges are dropped.
 */
function linkNodes(nodes: WikiNode[], wikiRoot: string): WikiEdge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges: WikiEdge[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const fileDir = path.dirname(path.join(wikiRoot, `${node.id}.md`));
    for (const link of markdownLinks(node.body)) {
      const target = toId(wikiRoot, path.resolve(fileDir, link));
      const targetNode = byId.get(target);
      const key = `${node.id}\n${target}`;
      if (!targetNode || target === node.id || seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: node.id, target });
      node.links.push(target);
      targetNode.backlinks.push(node.id);
    }
  }
  return edges;
}

/**
 * Build the in-memory node/edge graph from a wiki directory.
 */
export async function buildGraph(wikiRoot: string): Promise<WikiGraph> {
  const files = (await collectMarkdown(wikiRoot, wikiRoot)).sort();
  const nodes = await Promise.all(
    files.map((file) => readNode(file, wikiRoot)),
  );
  const edges = linkNodes(nodes, wikiRoot);
  return {
    root: path.basename(wikiRoot),
    generatedAt: new Date().toISOString(),
    types: [...new Set(nodes.map((node) => node.type))].sort(),
    nodes,
    edges,
  };
}
