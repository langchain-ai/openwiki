/**
 * Deterministically flags a graduated topic page as stale when the evidence
 * backing it has changed since it graduated — new records added, or
 * previously-cited ones no longer matching. Reuses OKF's existing
 * `stale_after` field (see src/okf/frontmatter.ts's `isIsoDateTimeWithOffset`
 * check) rather than inventing a new one.
 *
 * No LLM call: a pure diff between two already-computed evidence sets, using
 * the same clustering theme-extraction.ts does. A connector with no usable
 * taxonomy field simply produces nothing to compare — a silent no-op, not an
 * error.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { setFrontmatterValue } from "../okf/frontmatter.js";
import { clusterByBestField, findLatestRawPull, loadRawRecords } from "./theme-extraction.js";

const EVIDENCE_REF_PATTERN = /#\d{4,}|\b[A-Z]{2,6}-\d+\b/gu;
// A page must already cite a meaningful share of a theme's fresh evidence to
// be treated as covering it — otherwise a page that happens to share one
// citation with an unrelated theme would get marked stale for no reason.
const MIN_OVERLAP_SHARE = 0.3;

async function listTopicPages(wikiDir: string): Promise<string[]> {
  const topicsDir = path.join(wikiDir, "topics");
  try {
    return (await readdir(topicsDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "index.md")
      .map((entry) => path.join(topicsDir, entry.name));
  } catch {
    return [];
  }
}

/**
 * Re-clusters the connector's latest raw pull and, for every topic page
 * that already covers a meaningful share of a resulting theme's evidence
 * (matched by evidence overlap, not by name — a page's slug can drift from
 * its original theme key after a merge or split), marks it stale if the
 * fresh evidence set now includes anything the page doesn't already cite.
 * Returns how many pages were newly marked.
 */
export async function refreshStaleness(connectorId: string, wikiDir: string): Promise<number> {
  const rawPull = await findLatestRawPull(wikiDir, connectorId);
  if (!rawPull) return 0;

  const records = await loadRawRecords(rawPull);
  const themes = clusterByBestField(records);
  if (themes.length === 0) return 0;

  const topicPaths = await listTopicPages(wikiDir);
  const topicPages = await Promise.all(
    topicPaths.map(async (topicPath) => ({
      content: await readFile(topicPath, "utf8"),
      path: topicPath,
    })),
  );

  let marked = 0;
  for (const theme of themes) {
    const freshIds = new Set(theme.evidenceIds);
    if (freshIds.size === 0) continue;

    for (const page of topicPages) {
      const citedIds = new Set(page.content.match(EVIDENCE_REF_PATTERN) ?? []);
      const overlap = [...freshIds].filter((id) => citedIds.has(id)).length;
      if (overlap === 0 || overlap < freshIds.size * MIN_OVERLAP_SHARE) continue;

      const hasNewEvidence = [...freshIds].some((id) => !citedIds.has(id));
      if (!hasNewEvidence) continue;

      const updated = setFrontmatterValue(page.content, "stale_after", new Date().toISOString());
      if (updated !== page.content) {
        await writeFile(page.path, updated, "utf8");
        page.content = updated;
        marked += 1;
      }
    }
  }

  return marked;
}
