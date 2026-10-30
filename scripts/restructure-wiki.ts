#!/usr/bin/env -S node --experimental-strip-types
/**
 * Deterministic split/merge pass over the local wiki's `/topics/` pages.
 * Detects candidates in code (page size + section count for splits, shared
 * evidence for merges), executes each with a single narrow LLM call, then
 * repairs the link graph. Run after scripts/graduate-topics.ts, not instead
 * of it — this only reorganizes pages that already exist.
 *
 * Usage: pnpm exec tsx scripts/restructure-wiki.ts [--dry-run]
 */
import { loadOpenWikiEnv } from "../src/config/env.js";
import { openWikiLocalWikiDir } from "../src/config/openwiki-home.js";
import {
  detectMergeCandidates,
  detectSplitCandidates,
  repairWikiGraph,
} from "../src/wiki/graph-maintenance.js";
import { mergeTopics, splitTopic } from "../src/wiki/restructure.js";

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  await loadOpenWikiEnv();

  console.log("Step 1: repairing link graph before restructuring...");
  const before = await repairWikiGraph(openWikiLocalWikiDir);
  console.log(
    `  fixed ${before.reciprocalLinksAdded.length} reciprocal link(s), removed ${before.orphanedLinksRemoved.length} orphan(s)`,
  );

  const splitCandidates = await detectSplitCandidates(openWikiLocalWikiDir);
  console.log(`\nStep 2: ${splitCandidates.length} split candidate(s):`);
  for (const c of splitCandidates) {
    console.log(
      `  - ${c.relativePath} (${c.wordCount} words, sections: ${c.sections.join(", ")})`,
    );
  }

  const mergeCandidates = await detectMergeCandidates(openWikiLocalWikiDir);
  console.log(`\nStep 3: ${mergeCandidates.length} merge candidate(s):`);
  for (const c of mergeCandidates) {
    console.log(
      `  - ${c.pageA} <-> ${c.pageB} (shared evidence: ${c.sharedEvidence.join(", ")})`,
    );
  }

  if (dryRun) {
    console.log("\n--dry-run set, stopping before any LLM call.");
    return;
  }
  if (splitCandidates.length === 0 && mergeCandidates.length === 0) {
    console.log("\nNothing to restructure.");
    return;
  }

  console.log("\nStep 4: executing splits...");
  for (const candidate of splitCandidates) {
    console.log(`  splitting ${candidate.relativePath}...`);
    try {
      await splitTopic(candidate, openWikiLocalWikiDir);
      console.log("    done");
    } catch (error) {
      console.error(
        `    FAILED: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log("\nStep 5: executing merges...");
  for (const candidate of mergeCandidates) {
    console.log(`  merging ${candidate.pageA} <-> ${candidate.pageB}...`);
    try {
      await mergeTopics(candidate, openWikiLocalWikiDir);
      console.log("    done");
    } catch (error) {
      console.error(
        `    FAILED: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log("\nStep 6: repairing link graph after restructuring...");
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
