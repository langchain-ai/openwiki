#!/usr/bin/env -S node --experimental-strip-types
/**
 * Exports the current wiki's page graph (nodes + `related:`/body-link edges,
 * from src/wiki/graph-maintenance.ts) as JSON, for visualizing the mesh
 * network.
 *
 * Usage: pnpm exec tsx scripts/export-wiki-graph.ts > graph.json
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { openWikiLocalWikiDir } from "../src/config/openwiki-home.js";
import { loadWikiGraph } from "../src/wiki/graph-maintenance.js";
import {
  parseFrontmatterFields,
  splitFrontmatter,
} from "../src/okf/frontmatter.js";

interface GraphNode {
  id: string;
  title: string;
  type: string;
  group: string;
  description?: string;
  wordCount: number;
  degree: number;
}

interface GraphEdge {
  source: string;
  target: string;
}

function groupFor(relativePath: string, type: string): string {
  if (relativePath.startsWith("/topics/")) return "topic";
  if (relativePath.startsWith("/sources/")) return "source";
  if (relativePath === "/themes.md") return "themes";
  if (relativePath === "/commitments.md") return "commitments";
  if (relativePath === "/open-questions.md") return "open-questions";
  if (relativePath === "/quickstart.md" || relativePath === "/index.md")
    return "index";
  return type.toLowerCase() || "other";
}

async function main(): Promise<void> {
  const nodesByPath = await loadWikiGraph(openWikiLocalWikiDir);

  const nodes: GraphNode[] = [];
  const edgeSet = new Set<string>();
  const edges: GraphEdge[] = [];

  for (const [relativePath, node] of nodesByPath) {
    const raw = await readFile(node.absolutePath, "utf8").catch(
      () => node.content,
    );
    const fields = parseFrontmatterFields(raw) ?? {};
    const { body } = splitFrontmatter(raw);
    const wordCount = body.split(/\s+/u).filter(Boolean).length;
    const type = typeof fields.type === "string" ? fields.type : "";

    nodes.push({
      degree: new Set([...node.related, ...node.bodyLinks]).size,
      description:
        typeof fields.description === "string" ? fields.description : undefined,
      group: groupFor(relativePath, type),
      id: relativePath,
      title:
        typeof fields.title === "string"
          ? fields.title
          : path.basename(relativePath, ".md"),
      type,
      wordCount,
    });

    for (const target of new Set([...node.related, ...node.bodyLinks])) {
      if (!nodesByPath.has(target)) continue;
      const key = [relativePath, target].sort().join("::");
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push({ source: relativePath, target });
    }
  }

  console.log(JSON.stringify({ edges, nodes }, null, 2));
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exit(1);
});
