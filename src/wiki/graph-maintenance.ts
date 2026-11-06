/**
 * Deterministic upkeep for the wiki's `related:` link graph and per-theme
 * evidence counts.
 *
 * Bookkeeping with a single correct answer (is this link reciprocated? does
 * the target file exist? how many evidence rows does this theme have?)
 * belongs in code, not a prompt competing for the model's attention — the
 * agent should only make judgment calls, never keep a graph invariant true.
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  parseFrontmatterFields,
  setFrontmatterValue,
  splitFrontmatter,
} from "../okf/frontmatter.js";

/** One parsed wiki page and its outbound links. */
export interface WikiPageNode {
  /** Wiki-relative path with a leading slash, e.g. "/topics/pylon.md". */
  relativePath: string;

  /** Absolute filesystem path to the page. */
  absolutePath: string;

  /** Raw markdown content, as read from disk. */
  content: string;

  /** Normalized, in-wiki `related:` targets (entries outside the wiki or malformed are dropped). */
  related: string[];

  /**
   * Normalized, in-wiki targets found as plain `[text](path)` links in the page
   * body. Tracked separately from `related` because body links are never
   * rewritten (only `related:` frontmatter is), but they still count as real
   * edges for bidirectionality purposes — a page that links to another in
   * prose but forgot to list it in `related:` should still get a reciprocal
   * link written back.
   */
  bodyLinks: string[];
}

/** What {@link repairWikiGraph} changed, for reporting to a human or a caller. */
export interface GraphRepairReport {
  reciprocalLinksAdded: { from: string; to: string }[];
  orphanedLinksRemoved: { from: string; to: string }[];
  filesChanged: string[];
}

// Recognizes the evidence-reference shapes across supported connectors:
// Pylon (#31234), Linear/GitHub (LSO-4363, owner/repo#1234), and file-path
// evidence ids emitted by theme-extraction's classification fallback (e.g.
// "#docs-repo/src/langsmith/access-current-span.mdx"). The `#` form requires
// 4+ digits so prose enumerations like "(1) ... and (2) ..." aren't
// miscounted as ticket references. Two literals rather than one reused
// `g`-flagged instance, since a global regex's `.test()` advances
// `lastIndex` and would silently skip matches across repeated calls.
const EVIDENCE_REF_TEST = /#\d{4,}|\b[A-Z]{2,6}-\d+\b|#[\w-]+(?:\/[\w.-]+)+/u;
const EVIDENCE_REF_MATCH_ALL = /#\d{4,}|\b[A-Z]{2,6}-\d+\b|#[\w-]+(?:\/[\w.-]+)+/gu;

export function extractEvidenceRefs(text: string): Set<string> {
  return new Set(text.match(EVIDENCE_REF_MATCH_ALL) ?? []);
}

/** One row's worth of evidence tracked against a theme key on `/themes.md`. */
export interface ThemeEvidenceCount {
  themeKey: string;
  evidenceCount: number;
  hasTopicPage: boolean;
  /** The full, unmodified `/themes.md` table row, for passing straight into a graduation prompt. */
  rowText: string;
  /** The topic slug a graduated page for this row would use, e.g. "infrastructure-scaling". */
  slug: string;
}

/**
 * Resolves a `related:` entry against the wiki root, refusing anything that
 * would escape it — mirrors {@link resolveConnectorRawPath}'s containment
 * check in src/config/openwiki-home.ts.
 */
function resolveWikiPath(wikiDir: string, relativePath: string): string {
  const resolved = path.resolve(wikiDir, relativePath.replace(/^\/+/u, ""));
  if (resolved !== wikiDir && !resolved.startsWith(`${wikiDir}${path.sep}`)) {
    throw new Error(
      `related: path "${relativePath}" must stay inside the wiki directory.`,
    );
  }
  return resolved;
}

function toWikiRelative(wikiDir: string, absolutePath: string): string {
  return `/${path.relative(wikiDir, absolutePath).split(path.sep).join("/")}`;
}

/** Normalizes a raw `related:` frontmatter value into safe, wiki-relative paths. */
function normalizeRelated(wikiDir: string, value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    try {
      const resolved = resolveWikiPath(wikiDir, entry);
      out.push(toWikiRelative(wikiDir, resolved));
    } catch {
      // Outside the wiki directory or otherwise unsafe: drop rather than throw,
      // since a single bad link in agent-authored content should not abort a run.
    }
  }
  return [...new Set(out)];
}

/**
 * Extracts plain `[text](path)` markdown links from a page body and normalizes
 * any that point at another wiki page. External links (http(s), mailto),
 * pure same-page anchors (#section), and non-`.md` targets are ignored —
 * those aren't wiki-graph edges.
 */
function normalizeBodyLinks(
  wikiDir: string,
  selfRelativePath: string,
  body: string,
): string[] {
  const out: string[] = [];
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/gu;
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(body)) !== null) {
    const rawTarget = match[1].split("#")[0].trim();
    if (!rawTarget || !rawTarget.endsWith(".md")) continue;
    if (/^[a-z][a-z0-9+.-]*:/iu.test(rawTarget)) continue; // external scheme (http:, mailto:, ...)
    try {
      const resolved = resolveWikiPath(wikiDir, rawTarget);
      const relative = toWikiRelative(wikiDir, resolved);
      if (relative !== selfRelativePath) out.push(relative);
    } catch {
      // Outside the wiki directory: not a graph edge we can maintain.
    }
  }
  return [...new Set(out)];
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

/** Parses every markdown page under `wikiDir` into a graph of `related:` edges. */
export async function loadWikiGraph(
  wikiDir: string,
): Promise<Map<string, WikiPageNode>> {
  const nodes = new Map<string, WikiPageNode>();
  for (const absolutePath of await listMarkdownFiles(wikiDir)) {
    const content = await readFile(absolutePath, "utf8");
    const fields = parseFrontmatterFields(content) ?? {};
    const relativePath = toWikiRelative(wikiDir, absolutePath);
    const { body } = splitFrontmatter(content);
    nodes.set(relativePath, {
      absolutePath,
      bodyLinks: normalizeBodyLinks(wikiDir, relativePath, body),
      content,
      related: normalizeRelated(wikiDir, fields.related),
      relativePath,
    });
  }
  return nodes;
}

/**
 * Repairs the wiki's `related:` graph in place: drops `related:` entries that
 * point at pages that no longer exist, then adds any reciprocal `related:`
 * entry needed so every real link — whether declared in `related:` or found
 * as a plain body link — is bidirectional in the machine-readable graph.
 * Only `related:` frontmatter is ever rewritten; page bodies are untouched,
 * so a body link that targets a since-deleted page is simply not used to add
 * a reciprocal anywhere, rather than "removed" from prose no one asked to edit.
 */
export async function repairWikiGraph(
  wikiDir: string,
): Promise<GraphRepairReport> {
  const nodes = await loadWikiGraph(wikiDir);
  const report: GraphRepairReport = {
    filesChanged: [],
    orphanedLinksRemoved: [],
    reciprocalLinksAdded: [],
  };

  // What each page will end up declaring in `related:` — starts as exactly
  // its current declared list, since that is the only thing this function
  // writes.
  const finalRelated = new Map<string, Set<string>>();
  for (const [relativePath, node] of nodes) {
    finalRelated.set(relativePath, new Set(node.related));
  }

  for (const [relativePath, related] of finalRelated) {
    for (const target of [...related]) {
      if (!nodes.has(target)) {
        related.delete(target);
        report.orphanedLinksRemoved.push({ from: relativePath, to: target });
      }
    }
  }

  // What each page actually links to, for the purpose of deciding who owes a
  // reciprocal — the union of its declared `related:` and any plain body
  // links, since a prose link is just as real an edge as a declared one.
  for (const [relativePath, node] of nodes) {
    for (const target of new Set([...node.related, ...node.bodyLinks])) {
      if (!nodes.has(target)) continue;
      const targetRelated = finalRelated.get(target);
      if (targetRelated && !targetRelated.has(relativePath)) {
        targetRelated.add(relativePath);
        report.reciprocalLinksAdded.push({ from: target, to: relativePath });
      }
    }
  }

  for (const [relativePath, node] of nodes) {
    const finalList = [...(finalRelated.get(relativePath) ?? [])].sort();
    const originalList = [...node.related].sort();
    if (JSON.stringify(finalList) === JSON.stringify(originalList)) continue;

    const updated = setFrontmatterValue(node.content, "related", finalList);
    await writeFile(node.absolutePath, updated, "utf8");
    report.filesChanged.push(relativePath);
  }

  return report;
}

/**
 * Deterministically counts how many distinct evidence references back each
 * `/themes.md` row, and whether a corresponding `/topics/<slug>.md` page
 * already exists — the numbers a graduation decision should be driven by,
 * rather than the agent self-reporting them mid-synthesis.
 *
 * Expects `/themes.md` to use the same markdown-table convention the
 * synthesis policy already asks for: one row per theme, a stable topic key
 * in the first cell, and an "Evidence" column listing linked records
 * separated by commas.
 */
export async function countThemeEvidence(
  wikiDir: string,
): Promise<ThemeEvidenceCount[]> {
  let themesContent: string;
  try {
    themesContent = await readFile(path.join(wikiDir, "themes.md"), "utf8");
  } catch {
    return [];
  }

  const topicPageDir = path.join(wikiDir, "topics");
  let existingTopicSlugs: Set<string>;
  try {
    existingTopicSlugs = new Set(
      (await readdir(topicPageDir))
        .filter((name) => name.endsWith(".md"))
        .map((name) => name.replace(/\.md$/u, "")),
    );
  } catch {
    existingTopicSlugs = new Set();
  }

  const rows: ThemeEvidenceCount[] = [];
  for (const line of themesContent.split("\n")) {
    const cells = line
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0);
    if (cells.length < 2) continue;
    const rawThemeCell = cells[0].replace(/\*+/gu, "").trim();
    if (
      !rawThemeCell ||
      rawThemeCell.toLowerCase() === "theme" ||
      /^-+$/u.test(rawThemeCell)
    ) {
      continue;
    }

    // A theme cell that is already a markdown link (e.g.
    // "[Infrastructure Scaling](/topics/infrastructure-scaling.md)") means
    // this row was graduated in an earlier run. Extract the link text as the
    // theme key and the linked path as the authoritative "does a topic page
    // already exist" check — slugifying the raw cell text in that case would
    // slugify the URL along with it and produce a slug that matches nothing,
    // making an already-graduated row look ungraduated.
    const linkMatch = /^\[(?<text>[^\]]+)\]\((?<path>[^)]+)\)/u.exec(rawThemeCell);
    const themeKey = linkMatch?.groups?.text ?? rawThemeCell;
    const linkedTopicSlug = linkMatch?.groups?.path
      ?.replace(/^\/?topics\//u, "")
      .replace(/\.md$/u, "");

    const evidenceCell = cells.find((cell) => EVIDENCE_REF_TEST.test(cell));
    const evidenceCount = evidenceCell ? extractEvidenceRefs(evidenceCell).size : 0;
    const slug = linkedTopicSlug ?? slugify(themeKey);
    rows.push({
      evidenceCount,
      hasTopicPage: linkMatch !== null || existingTopicSlugs.has(slug),
      rowText: line.trim(),
      slug,
      themeKey,
    });
  }
  return rows;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

/** A `/topics/` page that has grown broad enough to be worth splitting. */
export interface SplitCandidate {
  relativePath: string;
  wordCount: number;
  /** Top-level `## ` section headings, one candidate sub-page per heading. */
  sections: string[];
}

/** Two `/topics/` pages that share enough evidence to be worth merging. */
export interface MergeCandidate {
  pageA: string;
  pageB: string;
  sharedEvidence: string[];
}

async function listTopLevelTopicPages(wikiDir: string): Promise<string[]> {
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
 * Flags `/topics/` pages broad enough to be split into several linked pages:
 * over `minWords` words AND at least `minSections` top-level `## ` sections
 * (a page can be long because it is one deep, focused explanation — the
 * section count is what actually indicates several distinct sub-topics have
 * been crammed into one page).
 */
// A page just created or restructured (split/merge/graduation) shouldn't
// immediately re-qualify for another split on the next pass — otherwise a
// freshly-split sub-page that still clears the word/section bar keeps
// splitting again, compounding into severe over-fragmentation across a burst
// of back-to-back runs. One hour breaks that cascade while still picking the
// page back up on the next legitimate ingestion.
const SPLIT_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Only pages generated BEFORE this run started are subject to the cooldown —
 * a page this SAME run just graduated must stay eligible for splitting in
 * the same pass, rather than sitting unsplit for a full hour even though
 * it's obviously ready to split the moment it's created.
 */
function isWithinSplitCooldown(content: string, now: number, runStartedAt: number): boolean {
  const generated = parseFrontmatterFields(content)?.generated as { at?: unknown } | undefined;
  const at = typeof generated?.at === "string" ? generated.at : undefined;
  if (!at) return false;
  const generatedAtMs = Date.parse(at);
  if (!Number.isFinite(generatedAtMs) || now < generatedAtMs) return false;
  if (generatedAtMs >= runStartedAt) return false;
  return now - generatedAtMs < SPLIT_COOLDOWN_MS;
}

export async function detectSplitCandidates(
  wikiDir: string,
  {
    minSections = 3,
    minWords = 1200,
    runStartedAt = Date.now(),
  }: {
    minSections?: number;
    minWords?: number;
    runStartedAt?: number;
  } = {},
): Promise<SplitCandidate[]> {
  const candidates: SplitCandidate[] = [];
  const now = Date.now();
  for (const absolutePath of await listTopLevelTopicPages(wikiDir)) {
    const content = await readFile(absolutePath, "utf8");
    if (isWithinSplitCooldown(content, now, runStartedAt)) continue;
    const { body } = splitFrontmatter(content);
    const wordCount = body.split(/\s+/u).filter(Boolean).length;
    const sections = [...body.matchAll(/^##\s+(.+?)\s*$/gmu)].map((m) => m[1]);
    if (wordCount >= minWords && sections.length >= minSections) {
      candidates.push({
        relativePath: toWikiRelative(wikiDir, absolutePath),
        sections,
        wordCount,
      });
    }
  }
  return candidates;
}

/** A `/topics/` page dense with distinct sub-topics but thin on real detail. */
export interface ShallowPageCandidate {
  relativePath: string;
  wordCount: number;
  sections: string[];
}

/**
 * Flags `/topics/` pages that list many distinct sub-topics (enough sections
 * to be several real topics) but spend very few words per section — the
 * "digest of citations" shape a graduation without real evidence access can
 * produce, where each section just paraphrases a doc's title instead of
 * drawing on its actual content. Distinct from detectSplitCandidates: that
 * catches pages too BIG to be one page; this catches pages too THIN to be
 * useful regardless of size, fixed by rewriting them deeper in place rather
 * than splitting into more equally-thin pages.
 */
export async function detectShallowPages(
  wikiDir: string,
  {
    minSections = 6,
    maxDensity = 150,
    runStartedAt = Date.now(),
  }: {
    minSections?: number;
    /** Average words per top-level section below which a page counts as shallow. */
    maxDensity?: number;
    runStartedAt?: number;
  } = {},
): Promise<ShallowPageCandidate[]> {
  const candidates: ShallowPageCandidate[] = [];
  const now = Date.now();
  for (const absolutePath of await listTopLevelTopicPages(wikiDir)) {
    const content = await readFile(absolutePath, "utf8");
    if (isWithinSplitCooldown(content, now, runStartedAt)) continue;
    const { body } = splitFrontmatter(content);
    const wordCount = body.split(/\s+/u).filter(Boolean).length;
    const sections = [...body.matchAll(/^##\s+(.+?)\s*$/gmu)].map((m) => m[1]);
    if (sections.length >= minSections && wordCount / sections.length < maxDensity) {
      candidates.push({
        relativePath: toWikiRelative(wikiDir, absolutePath),
        sections,
        wordCount,
      });
    }
  }
  return candidates;
}

/**
 * Flags pairs of `/topics/` pages that cite enough of the same underlying
 * evidence records to likely be the same real topic described twice.
 */
export async function detectMergeCandidates(
  wikiDir: string,
  { minSharedEvidence = 2 }: { minSharedEvidence?: number } = {},
): Promise<MergeCandidate[]> {
  const pages = await listTopLevelTopicPages(wikiDir);
  const evidenceByPage = new Map<string, Set<string>>();
  for (const absolutePath of pages) {
    const content = await readFile(absolutePath, "utf8");
    const { body } = splitFrontmatter(content);
    evidenceByPage.set(toWikiRelative(wikiDir, absolutePath), extractEvidenceRefs(body));
  }

  const relativePaths = [...evidenceByPage.keys()];
  const candidates: MergeCandidate[] = [];
  for (let i = 0; i < relativePaths.length; i += 1) {
    for (let j = i + 1; j < relativePaths.length; j += 1) {
      const [pageA, pageB] = [relativePaths[i], relativePaths[j]];
      const shared = [...(evidenceByPage.get(pageA) ?? [])].filter((ref) =>
        evidenceByPage.get(pageB)?.has(ref),
      );
      if (shared.length >= minSharedEvidence) {
        candidates.push({ pageA, pageB, sharedEvidence: shared });
      }
    }
  }
  return candidates;
}
