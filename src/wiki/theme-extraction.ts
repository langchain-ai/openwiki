/**
 * Deterministically clusters any connector's raw records into `/themes.md`
 * rows, with real evidence (record ids) and a templated description — no LLM
 * call, and no connector-specific knowledge. Complements the ingestion
 * agent's own theme-discovery step rather than replacing it, since that step
 * can skip theme-tracking under a large combined prompt.
 *
 * Must work for any connector, including ones OpenWiki doesn't ship today —
 * so it never hardcodes a field path for a specific connector (Pylon's
 * `custom_fields.category`, Linear's `team`, etc.). Instead it recursively
 * scans each record for fields whose KEY NAME looks like a taxonomy field
 * (category, type, label(s), tag(s), team, status, state, kind,
 * classification) at any nesting depth, tries every such field name found
 * across the pull, and keeps whichever one produces a reasonable clustering
 * (more than one non-trivial group, not one giant bucket). A connector with
 * no such field simply produces no deterministic themes.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseFrontmatterFields } from "../okf/frontmatter.js";

/** A record with enough generic shape to become one piece of theme evidence. */
export interface RawRecord {
  id: string;
  title: string;
  /** A real, clickable URL back to this record, if the raw data has one. */
  url: string | undefined;
  /** Every taxonomy-shaped field found on this record, keyed by field name. */
  categoricalFields: Map<string, string>;
}

/** One piece of evidence backing a theme: a record id plus, when available, a real link to it. */
export interface EvidenceRef {
  id: string;
  url: string | undefined;
}

export interface ExtractedTheme {
  fieldName: string;
  category: string;
  themeKey: string;
  count: number;
  sampleTitles: string[];
  evidenceIds: string[];
  /** Same records as evidenceIds, paired with a real URL when the raw data had one. */
  evidenceRefs: EvidenceRef[];
}

// Covers ticket-tracker field names (category/type/status/...) plus the
// natural grouping field other common source shapes use for the same
// purpose: a Slack export's "channel", a Notion/Jira "project"/"board", a
// Gmail/Drive "folder", a support queue's "queue"/"pipeline". Matches on
// field NAMES only, never a specific org's values.
const TAXONOMY_FIELD_NAMES =
  /^(categor(y|ies)|types?|labels?|tags?|teams?|status|states?|kind|classification|channels?|boards?|projects?|folders?|topics?|queues?|pipelines?|stages?)$/iu;
// Priority order, not one combined pattern: "number" (a human-facing
// sequential id — GitHub issue #, Pylon/Linear ticket #) should win over an
// internal "id" (often an opaque UUID) when a record has both.
const ID_FIELD_PRIORITY = [/^number$/iu, /^identifier$/iu, /^key$/iu, /^id$/iu];
const TITLE_FIELD_NAMES = /^(title|name|subject|summary)$/iu;
const URL_FIELD_NAMES = /^(url|link|href|permalink|htmlurl|html_url)$/iu;
const MAX_SCAN_DEPTH = 4;
const MAX_CATEGORY_VALUE_LENGTH = 60;

function beginMarker(connectorId: string): string {
  return `<!-- deterministic:${connectorId}:begin -->`;
}

function endMarker(connectorId: string): string {
  return `<!-- deterministic:${connectorId}:end -->`;
}

/** Finds the most recently fetched raw pull directory for a connector. */
export async function findLatestRawPull(
  wikiDir: string,
  connectorId: string,
): Promise<string | null> {
  // Raw pulls live at ~/.openwiki/connectors/<id>/raw/<ISO-timestamp>/, a
  // sibling of the wiki directory itself (both under ~/.openwiki/).
  const rawRoot = path.join(path.dirname(wikiDir), "connectors", connectorId, "raw");
  let entries: string[];
  try {
    entries = (await readdir(rawRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null;
  }
  const latest = entries.at(-1);
  return latest ? path.join(rawRoot, latest) : null;
}

const MAX_EVIDENCE_EXCERPTS = 15;
const MAX_EXCERPT_CHARS = 1500;

export interface EvidenceExcerpt {
  id: string;
  excerpt: string;
}

/**
 * Reads real content for a bounded set of file-path-shaped evidence ids,
 * resolved against a connector's raw pull root. Ids that don't look like a
 * file path (e.g. Pylon/Linear-style numeric/ticket ids) or that don't
 * resolve to a real, readable file are silently skipped — the same
 * "no signal here" tolerance the rest of this module uses.
 *
 * A graduation/split agent is sandboxed to the wiki directory and has no
 * filesystem access to a connector's raw pull, so it can only write from
 * the row's own brief citation unless given real content up front. This
 * runs in the orchestrator (which does have full filesystem access) to
 * resolve and read that content before the agent is invoked.
 */
export async function resolveEvidenceExcerpts(
  rawPullRoot: string,
  evidenceIds: Iterable<string>,
  { maxFiles = MAX_EVIDENCE_EXCERPTS, maxCharsPerFile = MAX_EXCERPT_CHARS }: { maxFiles?: number; maxCharsPerFile?: number } = {},
): Promise<EvidenceExcerpt[]> {
  const excerpts: EvidenceExcerpt[] = [];
  for (const rawId of evidenceIds) {
    if (excerpts.length >= maxFiles) break;
    // extractEvidenceRefs (graph-maintenance.ts) returns ids with a leading
    // "#" citation marker — strip it before treating the rest as a path.
    const id = rawId.replace(/^#/u, "");
    if (!id.includes("/")) continue;
    const resolved = path.resolve(rawPullRoot, id);
    if (resolved !== rawPullRoot && !resolved.startsWith(`${rawPullRoot}${path.sep}`)) continue;
    try {
      const content = await readFile(resolved, "utf8");
      excerpts.push({
        excerpt: content.length > maxCharsPerFile ? `${content.slice(0, maxCharsPerFile)}\n...(truncated)` : content,
        id,
      });
    } catch {
      // Not a real file at this path (non-file evidence id, or a stale
      // path) — skip, same tolerance as every other best-effort lookup here.
    }
  }
  return excerpts;
}

/** Recursively collects `{fieldName -> value}` for every taxonomy-shaped field on a record. */
function collectCategoricalFields(
  value: unknown,
  out: Map<string, string>,
  depth: number,
): void {
  if (depth > MAX_SCAN_DEPTH || value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (TAXONOMY_FIELD_NAMES.test(key)) {
      const values: unknown[] = Array.isArray(child) ? (child as unknown[]) : [child];
      for (const item of values) {
        const resolved = isRecord(item) && "value" in item ? item.value : item;
        if (typeof resolved === "string" && resolved.trim() && resolved.length <= MAX_CATEGORY_VALUE_LENGTH) {
          out.set(key.toLowerCase(), resolved.trim());
        }
      }
    }
    collectCategoricalFields(child, out, depth + 1);
  }
}

/** Finds the first field on a record whose name looks like an id or a title, at any depth. */
function findFirstMatching(value: unknown, pattern: RegExp, depth: number): string | undefined {
  if (depth > MAX_SCAN_DEPTH || value === null || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (pattern.test(key) && (typeof child === "string" || typeof child === "number")) {
      return String(child);
    }
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = findFirstMatching(child, pattern, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Tries each pattern in order and returns the first field found anywhere on
 * the record — used for "id" so a human-facing sequential number (GitHub
 * issue number, Pylon/Linear ticket number) wins over an internal
 * UUID-shaped `id` field when a record has both, rather than whichever
 * happens to come first in the raw JSON's own key order.
 */
function findFirstMatchingByPriority(
  value: unknown,
  patterns: readonly RegExp[],
): string | undefined {
  for (const pattern of patterns) {
    const found = findFirstMatching(value, pattern, 0);
    if (found !== undefined) return found;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Turns one already-parsed JSON value (a JSONL line, a `.json` array
 * element, ...) into a record, or undefined when it has no recognizable id
 * field. The field scanners recurse through the whole object regardless of
 * wrapper shape (e.g. Pylon's `{issue: {...}}`), so this is shared by every
 * raw-format reader below to keep "what counts as a record" defined once.
 */
function recordFromParsedObject(parsed: unknown): RawRecord | undefined {
  const id = findFirstMatchingByPriority(parsed, ID_FIELD_PRIORITY);
  if (id === undefined) return undefined;
  const categoricalFields = new Map<string, string>();
  collectCategoricalFields(parsed, categoricalFields, 0);
  const title = findFirstMatching(parsed, TITLE_FIELD_NAMES, 0);
  const url = findFirstMatching(parsed, URL_FIELD_NAMES, 0);
  return { categoricalFields, id, title: title ?? "", url };
}

async function loadJsonlRecords(rawDir: string): Promise<RawRecord[]> {
  let fileNames: string[];
  try {
    fileNames = (await readdir(rawDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const records: RawRecord[] = [];
  for (const fileName of fileNames) {
    const content = await readFile(path.join(rawDir, fileName), "utf8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const record = recordFromParsedObject(parsed);
      if (record) records.push(record);
    }
  }
  return records;
}

// "manifest.json" is a run description, not a record (see ingestion.ts's
// own exclusion of the same name).
const NON_RECORD_JSON_FILE_NAMES = /^manifest\.json$/iu;

/**
 * Finds the first property anywhere on an object whose value is a non-empty
 * array of objects — the common "{data: [...]}" / "{items: [...]}" REST
 * response shape, so a connector's own wrapper key name doesn't need to be
 * known ahead of time.
 */
function findRecordArray(value: unknown, depth = 0): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every(isRecord) ? value : undefined;
  }
  if (depth > MAX_SCAN_DEPTH || !isRecord(value)) return undefined;
  for (const child of Object.values(value)) {
    const found = findRecordArray(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * Fallback for connectors that write one or more plain `.json` files (a
 * single object, or an array) instead of `.jsonl`.
 */
async function loadJsonFileRecords(rawDir: string): Promise<RawRecord[]> {
  let fileNames: string[];
  try {
    fileNames = (await readdir(rawDir, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isFile() && entry.name.endsWith(".json") && !NON_RECORD_JSON_FILE_NAMES.test(entry.name),
      )
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const records: RawRecord[] = [];
  for (const fileName of fileNames) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path.join(rawDir, fileName), "utf8"));
    } catch {
      continue;
    }
    const items = findRecordArray(parsed);
    if (!items) continue;
    for (const item of items) {
      const record = recordFromParsedObject(item);
      if (record) records.push(record);
    }
  }
  return records;
}

/**
 * Tries every raw-pull shape this codebase knows how to read, in order, and
 * uses the first one that produces records: `.jsonl` (ticket-style
 * connectors), a plain `.json` array or array-wrapping object, then
 * individual `.md`/`.mdx` files (docs/kb-style connectors). A raw pull
 * matching none of these shapes safely produces zero records rather than a
 * forced grouping.
 */
export async function loadRawRecords(rawDir: string): Promise<RawRecord[]> {
  const jsonl = await loadJsonlRecords(rawDir);
  if (jsonl.length > 0) return jsonl;

  const json = await loadJsonFileRecords(rawDir);
  if (json.length > 0) return json;

  return loadRawFileRecords(rawDir);
}

// Directory-name conventions that hold assets/reusable fragments rather than
// real standalone pages, common across documentation-site generators
// (Mintlify, Docusaurus, Next.js, etc.). An incomplete list only costs
// coverage, never correctness, since this only removes candidates. "openwiki"
// is excluded separately: any deployment ingesting its own docs repo would
// otherwise pull in OpenWiki's own product documentation as self-referential
// meta-content.
const NON_CONTENT_DIR_NAMES =
  /^(snippets?|images?|assets?|static|public|fonts?|node_modules|openwiki)$/iu;
const MIN_FILE_RECORD_WORDS = 40;

async function listContentFiles(rootDir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (NON_CONTENT_DIR_NAMES.test(entry.name)) continue;
      files.push(...(await listContentFiles(full)));
    } else if (entry.isFile() && /\.mdx?$/iu.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Fallback for connectors that write individual `.md`/`.mdx` files per
 * document (docs, kb) instead of structured `.jsonl` records. Prose
 * content's natural taxonomy is its own folder structure, so each file's
 * immediate parent folder name is synthesized as a `"path"` entry in the
 * same `categoricalFields` map `loadRawRecords` produces — `clusterByBestField`
 * then treats it exactly like any other taxonomy field, threshold and
 * dominant-share rejection included.
 */
async function loadRawFileRecords(rawDir: string): Promise<RawRecord[]> {
  const files = await listContentFiles(rawDir);
  const records: RawRecord[] = [];
  for (const absolutePath of files) {
    let content: string;
    try {
      content = await readFile(absolutePath, "utf8");
    } catch {
      continue;
    }
    const wordCount = content.split(/\s+/u).filter(Boolean).length;
    if (wordCount < MIN_FILE_RECORD_WORDS) continue;

    const fields = parseFrontmatterFields(content);
    const relativePath = path.relative(rawDir, absolutePath).split(path.sep).join("/");
    const title =
      (typeof fields?.title === "string" && fields.title) ||
      path.basename(absolutePath).replace(/\.mdx?$/iu, "");
    const url = typeof fields?.url === "string" ? fields.url : undefined;

    const segments = relativePath.split("/");
    const categoricalFields = new Map<string, string>();
    // Only a real parent folder is a usable signal — a file sitting directly
    // under rawDir (segments.length === 1, e.g. a flat articles/ directory)
    // has no such signal, and every file sharing the SAME immediate parent as
    // rawDir itself would just recreate one giant bucket.
    if (segments.length > 1) {
      categoricalFields.set("path", segments.at(-2)!);
    }
    records.push({ categoricalFields, id: relativePath, title, url });
  }
  return records;
}

/**
 * Turns a raw category value into a readable label using only universal
 * string-shape transforms (camelCase/snake_case/kebab-case -> spaced title
 * case) — deliberately no organization-specific prefix stripping, so a
 * namespaced category (e.g. "lc_infrastructure") stays intact as "Lc
 * Infrastructure" rather than being silently rewritten for one org's scheme.
 */
function humanize(value: string): string {
  const spaced = value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ");
  return spaced.replace(/\b\w/gu, (char) => char.toUpperCase()).trim() || value;
}

/**
 * Tries every taxonomy field name found across the pull and clusters records
 * by whichever one actually produces a reasonable grouping: more than one
 * qualifying cluster, and no single cluster swallowing almost everything
 * (which usually means the field is closer to a constant than a real
 * category, e.g. every record sharing one "state" like "open").
 */
export function clusterByBestField(
  records: RawRecord[],
  { minRecords = 3, maxDominantShare = 0.7 }: { minRecords?: number; maxDominantShare?: number } = {},
): ExtractedTheme[] {
  const fieldNames = new Set<string>();
  for (const record of records) {
    for (const fieldName of record.categoricalFields.keys()) fieldNames.add(fieldName);
  }

  let best: ExtractedTheme[] = [];
  for (const fieldName of fieldNames) {
    const byCategory = new Map<string, RawRecord[]>();
    for (const record of records) {
      const value = record.categoricalFields.get(fieldName);
      if (!value) continue;
      const list = byCategory.get(value) ?? [];
      list.push(record);
      byCategory.set(value, list);
    }

    const totalCategorized = [...byCategory.values()].reduce((sum, list) => sum + list.length, 0);
    const largest = Math.max(0, ...[...byCategory.values()].map((list) => list.length));
    const qualifying = [...byCategory.entries()].filter(([, list]) => list.length >= minRecords);
    if (
      qualifying.length < 2 ||
      totalCategorized === 0 ||
      largest / totalCategorized > maxDominantShare
    ) {
      continue;
    }

    const themes = qualifying
      .map(([category, items]): ExtractedTheme => ({
        category,
        count: items.length,
        evidenceIds: items.map((item) => `#${item.id}`),
        evidenceRefs: items.map((item) => ({ id: item.id, url: item.url })),
        fieldName,
        sampleTitles: items.map((item) => item.title).filter(Boolean).slice(0, 3),
        themeKey: humanize(category),
      }))
      .sort((a, b) => b.count - a.count);

    if (themes.length > best.length) best = themes;
  }
  return best;
}

function renderThemesBlock(connectorId: string, themes: ExtractedTheme[]): string {
  const rows = themes.map((theme) => {
    const samples = theme.sampleTitles.length
      ? ` (e.g. ${theme.sampleTitles.map((title) => `"${title}"`).join(", ")})`
      : "";
    const description = `${theme.count} records with ${theme.fieldName}="${theme.category}"${samples}`;
    const shownRefs = theme.evidenceRefs.slice(0, 15);
    // A real link when the raw record had one, so a reader (or an agent)
    // can click straight through to the original source instead of a bare,
    // unclickable id — this is the whole point of citing evidence at all.
    const evidence =
      shownRefs.map((ref) => (ref.url ? `[#${ref.id}](${ref.url})` : `#${ref.id}`)).join(", ") +
      (theme.evidenceRefs.length > shownRefs.length
        ? `, +${theme.evidenceRefs.length - shownRefs.length} more`
        : "");
    return `| **${theme.themeKey}** | ${description} | source-backed | ${evidence} | active |`;
  });

  return [
    beginMarker(connectorId),
    "| Theme | Description | Confidence | Evidence | Status |",
    "|---|---|---|---|---|",
    ...rows,
    endMarker(connectorId),
  ].join("\n");
}

/**
 * Writes the deterministic theme block into `/themes.md`, replacing only the
 * block from a prior run of this connector (if any) and leaving every other
 * line — including any other connector's block, or agent-authored content —
 * untouched. Creates `/themes.md` with minimal OKF front matter if it
 * doesn't exist yet.
 */
export async function writeDeterministicThemes(
  wikiDir: string,
  connectorId: string,
  themes: ExtractedTheme[],
): Promise<{ themeCount: number }> {
  const themesPath = path.join(wikiDir, "themes.md");
  const block = renderThemesBlock(connectorId, themes);

  let existing: string;
  try {
    existing = await readFile(themesPath, "utf8");
  } catch {
    existing =
      '---\ntype: Reference\ntitle: Themes\ndescription: Recurring themes and patterns across connected sources.\ngenerated: { by: "openwiki-deterministic-theme-extraction" }\n---\n\n# Themes\n';
  }

  const begin = beginMarker(connectorId);
  const end = endMarker(connectorId);
  const beginIndex = existing.indexOf(begin);
  const endIndex = existing.indexOf(end);

  const updated =
    beginIndex !== -1 && endIndex !== -1
      ? existing.slice(0, beginIndex) + block + existing.slice(endIndex + end.length)
      : `${existing.trimEnd()}\n\n${block}\n`;

  await writeFile(themesPath, updated, "utf8");
  return { themeCount: themes.length };
}
