import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { WikiEdge, WikiGraph, WikiMeta, WikiNode } from "./graph-types.js";

export type { WikiEdge, WikiGraph, WikiMeta, WikiNode } from "./graph-types.js";

/**
 * A raw frontmatter map: each key is either a scalar string or a string list.
 */
type RawMeta = Record<string, string | string[]>;

/**
 * Pages that are generation scaffolding, not real wiki content.
 */
const EXCLUDED_FILES = new Set(["INSTRUCTIONS.md", "log.md"]);

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
  // When the file ends at the closing --- (no trailing newline), indexOf
  // returns -1; treat that as an empty body so we match okf/frontmatter.ts
  // (FRONTMATTER_BLOCK accepts (?:\r?\n|$)).
  const newlineAfterClose = raw.indexOf("\n", end + 1);
  const body = newlineAfterClose === -1 ? "" : raw.slice(newlineAfterClose + 1);
  const meta: RawMeta = {};
  let pendingListKey: string | undefined;
  for (const line of block.split(/\r?\n/)) {
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
      let decodedLink = link;
      try {
        // Decode encoded filenames once, preserving literal percent sequences.
        decodedLink = decodeURIComponent(link);
      } catch {
        // Keep literal percent signs; the target must still match an existing node.
      }
      const target = toId(wikiRoot, path.resolve(fileDir, decodedLink));
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
