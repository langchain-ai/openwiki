/**
 * Deterministically computes how many distinct sources back each topic
 * page's claims, and writes it as a structured OKF field — a "how
 * corroborated is this" signal any org's ranking or UI logic can read.
 *
 * Pure graph computation, no LLM call: counts distinct `/sources/*.md` pages
 * reachable from a topic page via `related:` or a body link, using data the
 * mesh (graph-maintenance.ts) already has. Keys off the `/sources/` path
 * convention OpenWiki uses universally, not any specific connector.
 */

import { readFile, writeFile } from "node:fs/promises";

import { setFrontmatterValue } from "../okf/frontmatter.js";
import { loadWikiGraph } from "./graph-maintenance.js";

/**
 * Recomputes and writes the `corroboration` field on every `/topics/*.md`
 * page. Returns how many pages actually changed.
 */
export async function refreshCorroboration(wikiDir: string): Promise<number> {
  const nodes = await loadWikiGraph(wikiDir);
  let changed = 0;

  for (const [relativePath, node] of nodes) {
    if (!relativePath.startsWith("/topics/")) continue;

    const sourceIds = [...new Set([...node.related, ...node.bodyLinks])]
      .filter((target) => target.startsWith("/sources/"))
      .map((target) => target.replace(/^\/sources\//u, "").replace(/\.md$/u, ""))
      .sort();

    const content = await readFile(node.absolutePath, "utf8");
    const updated = setFrontmatterValue(content, "corroboration", {
      sourceCount: sourceIds.length,
      sources: sourceIds,
    });
    if (updated !== content) {
      await writeFile(node.absolutePath, updated, "utf8");
      changed += 1;
    }
  }

  return changed;
}
