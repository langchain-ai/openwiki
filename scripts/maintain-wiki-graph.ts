#!/usr/bin/env -S node --experimental-strip-types
/**
 * Deterministic post-ingestion pass over the local wiki. Repairs the
 * `related:` link graph (bidirectionality, orphaned links) and reports which
 * `/themes.md` rows now have enough evidence to graduate into a `/topics/`
 * page, without any LLM call. Run after `openwiki ingest`, not instead of it.
 *
 * Usage: pnpm exec tsx scripts/maintain-wiki-graph.ts [--threshold N]
 */
import { openWikiLocalWikiDir } from "../src/config/openwiki-home.js";
import {
  countThemeEvidence,
  repairWikiGraph,
} from "../src/wiki/graph-maintenance.js";

async function main(): Promise<void> {
  const thresholdArg = process.argv.indexOf("--threshold");
  const threshold =
    thresholdArg !== -1 && process.argv[thresholdArg + 1]
      ? Number(process.argv[thresholdArg + 1])
      : 2;

  const report = await repairWikiGraph(openWikiLocalWikiDir);
  console.log(`Graph repair (${openWikiLocalWikiDir}):`);
  console.log(
    `  reciprocal links added: ${report.reciprocalLinksAdded.length}`,
  );
  for (const { from, to } of report.reciprocalLinksAdded) {
    console.log(`    + ${from} -> ${to}`);
  }
  console.log(
    `  orphaned links removed: ${report.orphanedLinksRemoved.length}`,
  );
  for (const { from, to } of report.orphanedLinksRemoved) {
    console.log(`    - ${from} -> ${to}`);
  }
  console.log(`  files changed: ${report.filesChanged.length}`);
  for (const relativePath of report.filesChanged) {
    console.log(`    * ${relativePath}`);
  }

  const themeCounts = await countThemeEvidence(openWikiLocalWikiDir);
  const candidates = themeCounts.filter(
    (row) => row.evidenceCount >= threshold && !row.hasTopicPage,
  );
  console.log(
    `\nGraduation candidates (evidence >= ${threshold}, no /topics/ page yet): ${candidates.length}`,
  );
  for (const row of candidates) {
    console.log(`  - ${row.themeKey} (${row.evidenceCount} evidence records)`);
  }
  if (themeCounts.length === 0) {
    console.log("  (no /themes.md rows found — nothing to evaluate)");
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exit(1);
});
