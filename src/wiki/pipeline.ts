/**
 * Runs the full deterministic wiki-maintenance pass (theme extraction, graph
 * repair, graduation, split/merge, corroboration, staleness) for one
 * connector, so ingestion can trigger it automatically.
 *
 * Generic by construction: makes no assumption about a connector's raw data
 * shape, and every step that finds nothing to do is a no-op, not an error.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { openWikiLocalWikiDir } from "../config/openwiki-home.js";
import { splitFrontmatter } from "../okf/frontmatter.js";
import { runSourceUpdateProcess } from "../ingestion/run-source-update-process.js";
import { sanitizeDiagnosticText } from "../platform/diagnostics.js";
import { OPENWIKI_PACKAGE_ROOT } from "../version.js";
import {
  countThemeEvidence,
  detectMergeCandidates,
  detectShallowPages,
  detectSplitCandidates,
  extractEvidenceRefs,
  type MergeCandidate,
  repairWikiGraph,
} from "./graph-maintenance.js";
import { createEnrichmentMessage, createGraduationMessage } from "./graduation.js";
import { createMergeMessage, createSplitMessage } from "./restructure.js";
import {
  clusterByBestField,
  type ExtractedTheme,
  findLatestRawPull,
  loadRawRecords,
  type RawRecord,
  resolveEvidenceExcerpts,
  writeDeterministicThemes,
} from "./theme-extraction.js";
import { classifyRecordsWithLLM } from "./content-classification.js";
import { refreshCorroboration } from "./corroboration.js";
import { refreshStaleness } from "./staleness.js";

// A cluster this much larger than typical (minRecords is usually single
// digits to a few dozen) usually means the taxonomy field found a real
// category that's too broad to be one topic page (e.g. a flat docs folder
// spanning an entire product surface), not a naturally-sized theme.
const MEGA_CLUSTER_RECORD_THRESHOLD = 80;

/**
 * Splits a disproportionately large theme into finer sub-themes by running
 * its records through the same LLM classification used as the zero-signal
 * fallback, then re-clustering the result. Themes at or under the
 * threshold, or that the LLM can't usefully subdivide, pass through
 * unchanged.
 */
export async function refineMegaClusters(
  records: RawRecord[],
  themes: ExtractedTheme[],
  minRecords: number,
): Promise<ExtractedTheme[]> {
  const refined: ExtractedTheme[] = [];
  for (const theme of themes) {
    if (theme.count <= MEGA_CLUSTER_RECORD_THRESHOLD) {
      refined.push(theme);
      continue;
    }
    const themeRecords = records.filter(
      (record) => record.categoricalFields.get(theme.fieldName) === theme.category,
    );
    const classified = await classifyRecordsWithLLM(themeRecords);
    const subThemes = clusterByBestField(classified, { minRecords });
    refined.push(...(subThemes.length > 1 ? subThemes : [theme]));
  }
  return refined;
}

export interface MeshMaintenanceReport {
  connectorId: string;
  themesExtracted: number;
  reciprocalLinksFixed: number;
  orphanedLinksRemoved: number;
  themesGraduated: number;
  themesGraduationFailed: number;
  pagesEnriched: number;
  pagesEnrichmentFailed: number;
  pagesSplit: number;
  pagesSplitFailed: number;
  pagesMerged: number;
  pagesMergeFailed: number;
  pagesCorroborated: number;
  pagesMarkedStale: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Candidates within a loop are independent subprocess calls, so running
// several at once is a pure wall-clock win. Bounded to stay reasonable
// against API rate limits and per-subprocess memory overhead.
const MESH_MAINTENANCE_CONCURRENCY =
  Number(process.env.OPENWIKI_MESH_MAINTENANCE_CONCURRENCY) || 4;

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  async function runNext(): Promise<void> {
    for (;;) {
      const i = index++;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
}

/**
 * Greedily groups merge candidates into batches where no page (as either
 * pageA or pageB) appears twice in the same batch. Candidates within a batch
 * run concurrently; two candidates sharing a page would otherwise have two
 * agents write the same file at once, silently losing whichever wrote
 * second. Batches themselves still run one after another.
 */
export function batchMergeCandidates(candidates: MergeCandidate[]): MergeCandidate[][] {
  const batches: MergeCandidate[][] = [];
  const remaining = [...candidates];
  while (remaining.length > 0) {
    const batch: MergeCandidate[] = [];
    const usedPages = new Set<string>();
    for (let i = 0; i < remaining.length; ) {
      const candidate = remaining[i];
      if (!usedPages.has(candidate.pageA) && !usedPages.has(candidate.pageB)) {
        batch.push(candidate);
        usedPages.add(candidate.pageA);
        usedPages.add(candidate.pageB);
        remaining.splice(i, 1);
      } else {
        i += 1;
      }
    }
    batches.push(batch);
  }
  return batches;
}

export interface MeshMaintenanceOptions {
  /** Minimum records in a cluster for deterministic theme extraction to keep it. */
  minRecords?: number;
  /** Minimum evidence count for a theme to graduate into its own page. */
  graduationThreshold?: number;
}

/**
 * Runs every deterministic maintenance step for one connector's wiki
 * content. Safe to call after any ingestion run — each step degrades to a
 * no-op rather than failing when there's nothing to do.
 */
export async function runMeshMaintenance(
  connectorId: string,
  wikiDir: string = openWikiLocalWikiDir,
  { graduationThreshold = 2, minRecords = 3 }: MeshMaintenanceOptions = {},
): Promise<MeshMaintenanceReport> {
  // Captured up front: pages this run graduates must stay eligible for
  // splitting later in this same run (see detectSplitCandidates' cooldown).
  const runStartedAt = Date.now();
  const report: MeshMaintenanceReport = {
    connectorId,
    orphanedLinksRemoved: 0,
    pagesCorroborated: 0,
    pagesMarkedStale: 0,
    pagesEnriched: 0,
    pagesEnrichmentFailed: 0,
    pagesMerged: 0,
    pagesMergeFailed: 0,
    pagesSplit: 0,
    pagesSplitFailed: 0,
    reciprocalLinksFixed: 0,
    themesExtracted: 0,
    themesGraduated: 0,
    themesGraduationFailed: 0,
  };

  const rawPull = await findLatestRawPull(wikiDir, connectorId);
  if (rawPull) {
    const records = await loadRawRecords(rawPull);
    let themes = clusterByBestField(records, { minRecords });
    // No taxonomy field and no usable file-path structure — fall back to
    // narrow, batched LLM classification (never page-writing) and cluster
    // on the result like any other taxonomy field.
    if (themes.length === 0 && records.length > 0) {
      const classified = await classifyRecordsWithLLM(records);
      themes = clusterByBestField(classified, { minRecords });
    }
    themes = await refineMegaClusters(records, themes, minRecords);
    if (themes.length > 0) {
      const { themeCount } = await writeDeterministicThemes(wikiDir, connectorId, themes);
      report.themesExtracted = themeCount;
    }
  }

  const beforeRepair = await repairWikiGraph(wikiDir);
  report.reciprocalLinksFixed += beforeRepair.reciprocalLinksAdded.length;
  report.orphanedLinksRemoved += beforeRepair.orphanedLinksRemoved.length;

  // Each candidate below is one independent LLM agent call, run in its own
  // subprocess with a hard timeout (see run-mesh-maintenance-process.ts) —
  // chaining many agent calls in one long-lived process is unreliable here,
  // and an in-process call has no timeout, so a hung candidate could block
  // the whole run. A candidate that times out or errors is caught and
  // skipped without affecting the rest.
  if (!OPENWIKI_PACKAGE_ROOT) {
    console.error(
      "[mesh-maintenance] could not resolve the openwiki package root; skipping graduation/split/merge for this run.",
    );
  } else {
    // Re-bound to a plain string so the narrowing survives capture in the
    // async closures below.
    const repoRoot: string = OPENWIKI_PACKAGE_ROOT;
    const graduationCandidates = (await countThemeEvidence(wikiDir)).filter(
      (row) => row.evidenceCount >= graduationThreshold && !row.hasTopicPage,
    );
    // Each graduation candidate targets its own distinct /topics/<slug>.md —
    // safe to run concurrently, no shared-file overlap between candidates.
    await runWithConcurrency(graduationCandidates, MESH_MAINTENANCE_CONCURRENCY, async (candidate) => {
      try {
        // Real content for the row's cited evidence, so graduation writes
        // from actual source text — the agent has no filesystem access to
        // the raw pull to look this up itself.
        const evidenceExcerpts = rawPull
          ? await resolveEvidenceExcerpts(rawPull, extractEvidenceRefs(candidate.rowText))
          : [];
        await runSourceUpdateProcess(
          createGraduationMessage(candidate, evidenceExcerpts),
          wikiDir,
          repoRoot,
        );
        report.themesGraduated += 1;
      } catch (error) {
        report.themesGraduationFailed += 1;
        console.error(
          `[mesh-maintenance] graduation failed for theme "${candidate.themeKey}": ${sanitizeDiagnosticText(errorMessage(error))}`,
        );
      }
    });

    // Each shallow-page candidate is an existing page rewritten in place —
    // same no-shared-file-overlap reasoning, safe to run concurrently.
    await runWithConcurrency(
      await detectShallowPages(wikiDir, { runStartedAt }),
      MESH_MAINTENANCE_CONCURRENCY,
      async (candidate) => {
        try {
          const existing = await readFile(path.join(wikiDir, candidate.relativePath), "utf8");
          const { body } = splitFrontmatter(existing);
          const evidenceExcerpts = rawPull
            ? await resolveEvidenceExcerpts(rawPull, extractEvidenceRefs(body))
            : [];
          await runSourceUpdateProcess(
            createEnrichmentMessage(candidate, evidenceExcerpts),
            wikiDir,
            repoRoot,
          );
          report.pagesEnriched += 1;
        } catch (error) {
          report.pagesEnrichmentFailed += 1;
          console.error(
            `[mesh-maintenance] enrichment failed for "${candidate.relativePath}": ${sanitizeDiagnosticText(errorMessage(error))}`,
          );
        }
      },
    );

    // Each split candidate is itself a distinct existing oversized page —
    // same reasoning, safe to run concurrently.
    await runWithConcurrency(
      await detectSplitCandidates(wikiDir, { runStartedAt }),
      MESH_MAINTENANCE_CONCURRENCY,
      async (candidate) => {
        try {
          await runSourceUpdateProcess(createSplitMessage(candidate), wikiDir, repoRoot);
          report.pagesSplit += 1;
        } catch (error) {
          report.pagesSplitFailed += 1;
          console.error(
            `[mesh-maintenance] split failed for "${candidate.relativePath}": ${sanitizeDiagnosticText(errorMessage(error))}`,
          );
        }
      },
    );

    // Merge candidates can share a page (two pairs both naming the same
    // oversized page as pageA) — batch into conflict-free groups first, run
    // each batch concurrently, batches themselves sequentially.
    for (const batch of batchMergeCandidates(await detectMergeCandidates(wikiDir))) {
      await runWithConcurrency(batch, MESH_MAINTENANCE_CONCURRENCY, async (candidate) => {
        try {
          await runSourceUpdateProcess(createMergeMessage(candidate), wikiDir, repoRoot);
          report.pagesMerged += 1;
        } catch (error) {
          report.pagesMergeFailed += 1;
          console.error(
            `[mesh-maintenance] merge failed for "${candidate.pageA}" + "${candidate.pageB}": ${sanitizeDiagnosticText(errorMessage(error))}`,
          );
        }
      });
    }
  }

  const afterRepair = await repairWikiGraph(wikiDir);
  report.reciprocalLinksFixed += afterRepair.reciprocalLinksAdded.length;
  report.orphanedLinksRemoved += afterRepair.orphanedLinksRemoved.length;

  report.pagesCorroborated = await refreshCorroboration(wikiDir);
  report.pagesMarkedStale = await refreshStaleness(connectorId, wikiDir);

  return report;
}
