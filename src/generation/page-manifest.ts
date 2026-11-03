import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { normalizeWikiPagePath } from "../claims/brains/code/paths.js";
import { ClaimsStore } from "../claims/brains/code/store.js";
import { isFileNotFoundError } from "../platform/fs-errors.js";
import {
  DEFAULT_REPOSITORY_WIKI_DIRECTORY,
  RepositoryWikiPaths,
  resolveRepositoryWikiRoot,
} from "../repository-wiki/paths.js";
import { RepositoryRunError } from "./errors.js";

/**
 * Basename of the committed page-correctness manifest.
 */
export const REPOSITORY_PAGE_MANIFEST_BASENAME = ".page-manifest.json";

/**
 * Backward-compatible path policy for unconfigured repository wikis.
 */
const DEFAULT_PAGE_MANIFEST_WIKI_PATHS = new RepositoryWikiPaths(
  DEFAULT_REPOSITORY_WIKI_DIRECTORY,
);

/**
 * Current on-disk repository page-manifest schema version.
 */
export const REPOSITORY_PAGE_MANIFEST_SCHEMA_VERSION = 1 as const;

/**
 * Exact repository source checkpoint covered by one completed page.
 */
export interface RepositorySourceCheckpoint {
  /**
   * Commit through which the page was checked.
   *
   * @default undefined for an unborn repository or legacy state without HEAD.
   */
  gitHead?: string;

  /**
   * Exact source-input fingerprint used by the completing run.
   *
   * @default undefined only for entries migrated from `.last-update.json`.
   */
  sourceFingerprint?: string;
}

/**
 * Durable correctness checkpoint for one factual generated page.
 */
export interface RepositoryPageManifestEntry extends RepositorySourceCheckpoint {
  /**
   * Hash of the exact Markdown bytes whose Claims were verified.
   */
  pageVersion: string;

  /**
   * Producer that authored the durably verified page body.
   *
   * @default undefined for coverage migrated from legacy metadata.
   */
  completedBy?: string;

  /**
   * Durable run that recorded `completedBy` for this page.
   *
   * @default undefined for coverage created before per-page provenance.
   */
  completedRunId?: string;
}

/**
 * Complete committed page-correctness ledger.
 */
export interface RepositoryPageManifest {
  /**
   * On-disk schema discriminator.
   */
  schemaVersion: 1;

  /**
   * Canonical factual page paths mapped to their latest durable coverage.
   */
  pages: Record<string, RepositoryPageManifestEntry>;
}

/**
 * Runtime validator for a source-input fingerprint.
 */
const SourceFingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

/**
 * Runtime validator for an exact generated-page content hash.
 */
const PageVersionSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

/**
 * Runtime validator for one durable page-coverage entry.
 */
const ManifestEntrySchema = z
  .object({
    gitHead: z.string().min(1).optional(),
    sourceFingerprint: SourceFingerprintSchema.optional(),
    pageVersion: PageVersionSchema,
    completedBy: z.string().trim().min(1).optional(),
    completedRunId: z.string().uuid().optional(),
  })
  .strict();

/**
 * Runtime validator for the complete committed page manifest.
 */
const ManifestSchema = z
  .object({
    schemaVersion: z.literal(REPOSITORY_PAGE_MANIFEST_SCHEMA_VERSION),
    pages: z.record(z.string().min(1), ManifestEntrySchema),
  })
  .strict();

/**
 * Creates an empty V1 manifest.
 *
 * @returns New mutable manifest state with no page coverage.
 */
export function createEmptyRepositoryPageManifest(): RepositoryPageManifest {
  return { schemaVersion: 1, pages: {} };
}

/**
 * Resolves the committed page-manifest path below a repository root.
 *
 * @param root - Absolute repository root.
 * @param wikiPaths - Canonical physical repository wiki path policy.
 * @returns Absolute manifest path.
 */
export function repositoryPageManifestPath(
  root: string,
  wikiPaths: RepositoryWikiPaths = DEFAULT_PAGE_MANIFEST_WIKI_PATHS,
): string {
  return path.join(
    resolveRepositoryWikiRoot(root, wikiPaths.directory),
    REPOSITORY_PAGE_MANIFEST_BASENAME,
  );
}

/**
 * Loads and validates the committed page manifest.
 *
 * @param root - Absolute repository root.
 * @param wikiPaths - Canonical physical repository wiki path policy.
 * @returns Valid manifest, or an empty manifest when no file exists.
 * @throws RepositoryRunError when persisted state is malformed.
 */
export async function readRepositoryPageManifest(
  root: string,
  wikiPaths: RepositoryWikiPaths = DEFAULT_PAGE_MANIFEST_WIKI_PATHS,
): Promise<RepositoryPageManifest> {
  const file = repositoryPageManifestPath(root, wikiPaths);
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    const manifest = ManifestSchema.parse(parsed);
    assertCanonicalManifestPages(manifest, wikiPaths);
    return manifest;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return createEmptyRepositoryPageManifest();
    }
    if (error instanceof RepositoryRunError) throw error;
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new RepositoryRunError(
        "invalid_state",
        `OpenWiki page manifest is malformed at ${file}; refusing to discard committed page coverage.`,
      );
    }
    throw error;
  }
}

/**
 * Atomically replaces the complete committed page manifest.
 *
 * @param root - Absolute repository root.
 * @param manifest - Complete manifest state to validate and persist.
 * @param wikiPaths - Canonical physical repository wiki path policy.
 * @throws RepositoryRunError when a page path is not canonical and factual.
 */
export async function writeRepositoryPageManifest(
  root: string,
  manifest: RepositoryPageManifest,
  wikiPaths: RepositoryWikiPaths = DEFAULT_PAGE_MANIFEST_WIKI_PATHS,
): Promise<void> {
  const ordered: RepositoryPageManifest = {
    schemaVersion: 1,
    pages: Object.fromEntries(
      Object.entries(manifest.pages).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    ),
  };
  ManifestSchema.parse(ordered);
  assertCanonicalManifestPages(ordered, wikiPaths);

  const file = repositoryPageManifestPath(root, wikiPaths);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(ordered, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Records one page only after its Markdown and Claims state are durable.
 *
 * @param root - Absolute repository root that owns the generated wiki.
 * @param page - Canonical factual page path.
 * @param source - Exact repository source checkpoint verified by the page.
 * @param completedBy - Producer that authored the completed page.
 * @param completedRunId - Durable run that completed the page.
 * @param wikiPaths - Canonical physical repository wiki path policy.
 * @returns The durable manifest entry written for the page.
 * @throws RepositoryRunError when the page and Claims sidecar disagree.
 */
export async function recordRepositoryPageCompletion(
  root: string,
  page: string,
  source: RepositorySourceCheckpoint,
  completedBy?: string,
  completedRunId?: string,
  wikiPaths: RepositoryWikiPaths = DEFAULT_PAGE_MANIFEST_WIKI_PATHS,
): Promise<RepositoryPageManifestEntry> {
  const canonicalPage = normalizeWikiPagePath(page, wikiPaths);
  const entry = await buildManifestEntry(
    root,
    canonicalPage,
    source,
    completedBy,
    completedRunId,
    wikiPaths,
  );
  const manifest = await readRepositoryPageManifest(root, wikiPaths);
  manifest.pages[canonicalPage] = entry;
  await writeRepositoryPageManifest(root, manifest, wikiPaths);
  return entry;
}

/**
 * Seeds missing manifest entries from the last successful repository baseline.
 *
 * Existing entries always win so migration cannot erase newer partial progress.
 * Unverifiable legacy pages remain uncovered for full review.
 *
 * @param root - Absolute repository root.
 * @param pages - Current factual pages eligible for migration.
 * @param gitHead - Last fully successful repository Git HEAD.
 * @param wikiPaths - Canonical physical repository wiki path policy.
 */
export async function seedRepositoryPageManifest(
  root: string,
  pages: readonly string[],
  gitHead: string,
  wikiPaths: RepositoryWikiPaths = DEFAULT_PAGE_MANIFEST_WIKI_PATHS,
): Promise<void> {
  const manifest = await readRepositoryPageManifest(root, wikiPaths);
  let changed = false;
  for (const page of pages) {
    const canonicalPage = normalizeWikiPagePath(page, wikiPaths);
    if (manifest.pages[canonicalPage]) continue;
    try {
      manifest.pages[canonicalPage] = await buildManifestEntry(
        root,
        canonicalPage,
        { gitHead },
        undefined,
        undefined,
        wikiPaths,
      );
      changed = true;
    } catch (error) {
      if (!(error instanceof RepositoryRunError)) throw error;
      // Missing coverage deliberately routes this legacy page to full review.
    }
  }
  if (changed) await writeRepositoryPageManifest(root, manifest, wikiPaths);
}

/**
 * Replaces coverage with the complete surviving factual page inventory.
 *
 * @param root - Absolute repository root.
 * @param pages - Complete surviving factual page set after finalization.
 * @param source - Source checkpoint proven by successful whole-run finish.
 * @param preservePages - Restored pages whose exact prior coverage is retained.
 * @param preserveSourcePages - Pages that retain their prior source checkpoint.
 * @param wikiPaths - Canonical physical repository wiki path policy.
 */
export async function replaceRepositoryPageManifest(
  root: string,
  pages: readonly string[],
  source: RepositorySourceCheckpoint,
  preservePages: ReadonlySet<string> = new Set(),
  preserveSourcePages: ReadonlySet<string> = new Set(),
  wikiPaths: RepositoryWikiPaths = DEFAULT_PAGE_MANIFEST_WIKI_PATHS,
): Promise<void> {
  const next = createEmptyRepositoryPageManifest();
  const previous = await readRepositoryPageManifest(root, wikiPaths);
  for (const page of pages) {
    const canonicalPage = normalizeWikiPagePath(page, wikiPaths);
    if (preservePages.has(canonicalPage)) {
      const previousEntry = previous.pages[canonicalPage];
      if (previousEntry) next.pages[canonicalPage] = previousEntry;
      continue;
    }
    if (preserveSourcePages.has(canonicalPage)) {
      const previousEntry = previous.pages[canonicalPage];
      // A page this run did not (re)complete keeps its prior source checkpoint.
      // Deterministic finalization may still rewrite code-owned metadata on the
      // page, so re-prove the final Markdown/Claims pair before deciding whether
      // the exact prior entry can be retained.
      if (previousEntry) {
        const refreshedEntry = await buildManifestEntry(
          root,
          canonicalPage,
          {
            ...(previousEntry.gitHead
              ? { gitHead: previousEntry.gitHead }
              : {}),
            ...(previousEntry.sourceFingerprint
              ? { sourceFingerprint: previousEntry.sourceFingerprint }
              : {}),
          },
          previousEntry.completedBy,
          previousEntry.completedRunId,
          wikiPaths,
        );
        next.pages[canonicalPage] =
          refreshedEntry.pageVersion === previousEntry.pageVersion
            ? previousEntry
            : refreshedEntry;
        continue;
      }
      // No prior coverage exists for this untouched page. Try to seed a
      // first coverage entry from its current durable state, but never fail
      // the whole run over a page it did not touch; leave it uncovered for
      // full review instead, matching legacy/never-covered page handling.
      try {
        next.pages[canonicalPage] = await buildManifestEntry(
          root,
          canonicalPage,
          source,
          undefined,
          undefined,
          wikiPaths,
        );
      } catch (error) {
        if (error instanceof RepositoryRunError) continue;
        throw error;
      }
      continue;
    }
    next.pages[canonicalPage] = await buildManifestEntry(
      root,
      canonicalPage,
      source,
      previous.pages[canonicalPage]?.completedBy,
      previous.pages[canonicalPage]?.completedRunId,
      wikiPaths,
    );
  }
  await writeRepositoryPageManifest(root, next, wikiPaths);
}

/**
 * Checks whether committed coverage proves one page completed for a source.
 *
 * The current Markdown and Claims page versions are rechecked so a stale
 * manifest entry cannot promote a pending PageJob.
 *
 * @param root - Absolute repository root.
 * @param page - Canonical factual page path.
 * @param source - Exact active-run source checkpoint.
 * @param wikiPaths - Canonical physical repository wiki path policy.
 * @returns Whether the page is durable and current for the checkpoint.
 */
export async function isRepositoryPageCompletionCurrent(
  root: string,
  page: string,
  source: RepositorySourceCheckpoint,
  wikiPaths: RepositoryWikiPaths = DEFAULT_PAGE_MANIFEST_WIKI_PATHS,
): Promise<boolean> {
  return (
    (await getCurrentRepositoryPageCompletion(
      root,
      page,
      source,
      wikiPaths,
    )) !== null
  );
}

/**
 * Returns current durable completion coverage for one page.
 *
 * @param root - Absolute repository root.
 * @param page - Canonical factual page path.
 * @param source - Exact active-run source checkpoint.
 * @param wikiPaths - Canonical physical repository wiki path policy.
 * @returns Matching verified manifest entry, or `null` when coverage is stale.
 */
export async function getCurrentRepositoryPageCompletion(
  root: string,
  page: string,
  source: RepositorySourceCheckpoint,
  wikiPaths: RepositoryWikiPaths = DEFAULT_PAGE_MANIFEST_WIKI_PATHS,
): Promise<RepositoryPageManifestEntry | null> {
  if (!source.sourceFingerprint) return null;

  const canonicalPage = normalizeWikiPagePath(page, wikiPaths);
  const entry = (await readRepositoryPageManifest(root, wikiPaths)).pages[
    canonicalPage
  ];
  if (!entry || entry.sourceFingerprint !== source.sourceFingerprint) {
    return null;
  }
  if (source.gitHead !== undefined && entry.gitHead !== source.gitHead) {
    return null;
  }
  try {
    const store = new ClaimsStore(root, wikiPaths);
    const sidecar = await store.loadPage(canonicalPage);
    const current =
      sidecar?.verification !== undefined &&
      sidecar.pageVersion === entry.pageVersion &&
      (await store.hashPage(canonicalPage)) === entry.pageVersion;
    return current ? entry : null;
  } catch {
    return null;
  }
}

/**
 * Builds a manifest entry from mutually consistent Markdown and Claims state.
 *
 * @param root - Absolute repository root.
 * @param page - Canonical factual page path.
 * @param source - Source checkpoint covered by the page.
 * @param completedBy - Producer that authored the completed page.
 * @param completedRunId - Durable run that completed the page.
 * @param wikiPaths - Canonical physical repository wiki path policy.
 * @returns Valid entry bound to the current Markdown bytes.
 * @throws RepositoryRunError when the page is not durably verified.
 */
async function buildManifestEntry(
  root: string,
  page: string,
  source: RepositorySourceCheckpoint,
  completedBy?: string,
  completedRunId?: string,
  wikiPaths: RepositoryWikiPaths = DEFAULT_PAGE_MANIFEST_WIKI_PATHS,
): Promise<RepositoryPageManifestEntry> {
  const canonicalPage = normalizeWikiPagePath(page, wikiPaths);
  const store = new ClaimsStore(root, wikiPaths);
  let persisted: Awaited<ReturnType<ClaimsStore["loadPage"]>>;
  let pageVersion: string;
  try {
    persisted = await store.loadPage(canonicalPage);
    pageVersion = await store.hashPage(canonicalPage);
  } catch {
    throwPageCoverageError(canonicalPage);
  }
  if (
    !persisted ||
    !persisted.verification ||
    persisted.pageVersion !== pageVersion
  ) {
    throwPageCoverageError(canonicalPage);
  }
  return {
    pageVersion,
    ...(completedBy ? { completedBy } : {}),
    ...(completedRunId ? { completedRunId } : {}),
    ...(source.gitHead ? { gitHead: source.gitHead } : {}),
    ...(source.sourceFingerprint
      ? { sourceFingerprint: source.sourceFingerprint }
      : {}),
  };
}

/**
 * Reports that a page cannot prove mutually consistent durable state.
 *
 * @param page - Canonical factual page path that failed verification.
 * @throws RepositoryRunError for every call.
 */
function throwPageCoverageError(page: string): never {
  throw new RepositoryRunError(
    "invalid_state",
    `Cannot advance page coverage for ${page}; Markdown and verified Claims are not durable.`,
  );
}

/**
 * Rejects manifest keys that are not canonical factual page paths.
 *
 * @param manifest - Parsed or caller-provided manifest to inspect.
 * @param wikiPaths - Canonical physical repository wiki path policy.
 * @throws RepositoryRunError when any page key is invalid or non-canonical.
 */
function assertCanonicalManifestPages(
  manifest: RepositoryPageManifest,
  wikiPaths: RepositoryWikiPaths,
): void {
  for (const page of Object.keys(manifest.pages)) {
    let canonicalPage: string;
    try {
      canonicalPage = normalizeWikiPagePath(page, wikiPaths);
    } catch (error) {
      throw new RepositoryRunError(
        "invalid_state",
        `OpenWiki page manifest contains an invalid page path ${page}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (canonicalPage !== page) {
      throw new RepositoryRunError(
        "invalid_state",
        `OpenWiki page manifest contains a non-canonical page path: ${page}`,
      );
    }
  }
}
