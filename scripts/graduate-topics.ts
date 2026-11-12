#!/usr/bin/env -S node --experimental-strip-types
/**
 * The full deterministic graduation pipeline. Repairs the link graph, finds
 * every /themes.md row that deterministically qualifies for its own page,
 * graduates each one with a single narrow LLM call, then repairs the graph
 * again so the new pages' `related:` links are bidirectional too.
 *
 * Usage: pnpm exec tsx scripts/graduate-topics.ts [--threshold N] [--dry-run]
 */
import { loadOpenWikiEnv } from "../src/config/env.js";
import { openWikiLocalWikiDir } from "../src/config/openwiki-home.js";
import {
  countThemeEvidence,
  repairWikiGraph,
} from "../src/wiki/graph-maintenance.js";
import { graduateTheme } from "../src/wiki/graduation.js";

async function main(): Promise<void> {
  const thresholdArg = process.argv.indexOf("--threshold");
  const threshold =
    thresholdArg !== -1 && process.argv[thresholdArg + 1]
      ? Number(process.argv[thresholdArg + 1])
      : 2;
  const dryRun = process.argv.includes("--dry-run");

  await loadOpenWikiEnv();

  console.log("Step 1: repairing link graph before graduation...");
  const before = await repairWikiGraph(openWikiLocalWikiDir);
  console.log(
    `  fixed ${before.reciprocalLinksAdded.length} reciprocal link(s), removed ${before.orphanedLinksRemoved.length} orphan(s)`,
  );

  const candidates = (await countThemeEvidence(openWikiLocalWikiDir)).filter(
    (row) => row.evidenceCount >= threshold && !row.hasTopicPage,
  );
  console.log(
    `\nStep 2: ${candidates.length} theme(s) qualify for graduation (evidence >= ${threshold}):`,
  );
  for (const c of candidates) {
    console.log(
      `  - ${c.themeKey} (${c.evidenceCount} evidence records) -> /topics/${c.slug}.md`,
    );
  }

  if (dryRun || candidates.length === 0) {
    console.log(
      dryRun
        ? "\n--dry-run set, stopping before any LLM call."
        : "\nNothing to graduate.",
    );
    return;
  }

  console.log(
    "\nStep 3: graduating each candidate (one scoped LLM call per theme)...",
  );
  for (const candidate of candidates) {
    console.log(`  graduating "${candidate.themeKey}"...`);
    try {
      await graduateTheme(candidate, openWikiLocalWikiDir);
      console.log(`    done: /topics/${candidate.slug}.md`);
    } catch (error) {
      console.error(
        `    FAILED: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log("\nStep 4: repairing link graph after graduation...");
  const after = await repairWikiGraph(openWikiLocalWikiDir);
  console.log(
    `  fixed ${after.reciprocalLinksAdded.length} reciprocal link(s), removed ${after.orphanedLinksRemoved.length} orphan(s)`,
  );
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exit(1);
});
