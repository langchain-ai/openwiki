import type { WikiGraph } from "./graph.js";

/**
 * The minimal node shape the search/type filter needs. Both the raw wiki nodes
 * from /api/graph and the force-graph render objects satisfy it structurally.
 */
export interface FilterableNode {
  /**
   * Stable page id (path relative to the wiki root, without .md).
   */
  id: string;

  /**
   * Display title.
   */
  title: string;

  /**
   * Page kind, matched against the active type filter.
   */
  type: string;

  /**
   * Topic tags, folded into the free-text search haystack.
   *
   * @default undefined - treated as no tags.
   */
  tags?: readonly string[];
}

/**
 * Node sphere colors, keyed by draw order. Saturated enough to hold their hue as
 * lit 3D spheres (pale pastels blow out to white under the scene lighting); the
 * legend swatches reuse these same values.
 */
export const PALETTE: readonly string[] = [
  "#4FA8F0",
  "#B6DE3E",
  "#D96FA6",
  "#A97FE0",
  "#D98A6B",
  "#3FBFA0",
  "#E0A63E",
  "#6E8FF0",
];

/**
 * HTML-escape the five characters that could break out of text or an attribute
 * value, so wiki-sourced strings are safe to assign to innerHTML.
 */
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

/**
 * Escape the HTML-significant characters in a string before it is inserted into
 * the DOM. This is the sole XSS gate for wiki-sourced text.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => HTML_ESCAPES[char] ?? char);
}

/**
 * Map each distinct node type to a palette color by its position in the list, so
 * the graph and legend agree on colors and they stay stable across reloads.
 */
export function colorsForTypes(
  types: readonly string[],
  palette: readonly string[] = PALETTE,
): Record<string, string> {
  const colors: Record<string, string> = {};
  types.forEach((type, i) => {
    colors[type] = palette[i % palette.length];
  });
  return colors;
}

/**
 * Convert a `#RRGGBB` hex color plus an alpha into an `rgba(...)` string, for
 * canvas glow fills and dimming. A non-6-digit input is returned unchanged.
 */
export function hexA(hex: string, alpha: number): string {
  const c = (hex || "").replace("#", "");
  if (c.length !== 6) return hex;
  const channel = (i: number): number => parseInt(c.slice(i, i + 2), 16);
  return `rgba(${channel(0)}, ${channel(2)}, ${channel(4)}, ${alpha})`;
}

/**
 * Node circle radius in graph units, scaled by page length and capped, with a
 * bonus for the entry (anchor) page so it reads as the starting point.
 */
export function nodeRadius(size: number, isAnchor: boolean): number {
  return 4 + Math.min(7, (size || 0) / 480) + (isAnchor ? 4 : 0);
}

/**
 * Whether a node survives the active search text and type filter. An empty query
 * or empty type matches everything.
 */
export function matchesFilter(
  node: FilterableNode,
  query: string,
  type: string,
): boolean {
  const haystack = `${node.title} ${node.id} ${(node.tags ?? []).join(" ")}`;
  const matchesQuery = !query || haystack.toLowerCase().includes(query);
  const matchesType = !type || node.type === type;
  return matchesQuery && matchesType;
}

/**
 * A stable fingerprint of the graph's topology (its node ids and directed edges).
 * When it is unchanged across a reload, the scene can be left untouched so the
 * layout and viewport do not snap.
 */
export function signature(graph: Pick<WikiGraph, "nodes" | "edges">): string {
  const nodes = graph.nodes
    .map((node) => node.id)
    .sort()
    .join("|");
  const edges = graph.edges
    .map((edge) => `${edge.source}>${edge.target}`)
    .sort()
    .join("|");
  return `${nodes}::${edges}`;
}

/**
 * Strip a leading YAML frontmatter block from a markdown body before it is
 * rendered in the reader. A body without frontmatter is returned unchanged.
 */
export function stripFrontmatter(body: string): string {
  if (!body.startsWith("---")) return body;
  const end = body.indexOf("\n---", 3);
  return end === -1 ? body : body.slice(body.indexOf("\n", end + 1) + 1);
}

/**
 * Resolve a relative link (`rel`) against a page's directory (`baseDir`) into a
 * normalized wiki path, collapsing `.` and `..` segments. Used to turn in-page
 * markdown links into node ids for in-app navigation.
 */
export function normalize(baseDir: string, rel: string): string {
  const parts = (baseDir ? baseDir.split("/") : []).concat(rel.split("/"));
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}
