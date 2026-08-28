import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { normalizeWikiPagePath } from "../claims/brains/code/paths.js";
import { ClaimsStore } from "../claims/brains/code/store.js";
import { PAGE_MANIFEST_PATH } from "../config/constants.js";
import { isFileNotFoundError } from "../platform/fs-errors.js";
import { RepositoryRunError } from "./errors.js";

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

const SourceFingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const PageVersionSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const ManifestEntrySchema = z
  .object({
    gitHead: z.string().min(1).optional(),
    sourceFingerprint: SourceFingerprintSchema.optional(),
    pageVersion: PageVersionSchema,
    completedBy: z.string().trim().min(1).optional(),
    completedRunId: z.string().uuid().optional(),
  })
  .strict();
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
 * @returns Absolute manifest path.
 */
export function repositoryPageManifestPath(root: string): string {
  return path.join(root, PAGE_MANIFEST_PATH);
}

/**
 * Loads and validates the committed page manifest.
 *
 * @param root - Absolute repository root.
 * @returns Valid manifest, or an empty manifest when no file exists.
 * @throws RepositoryRunError when persisted state is malformed.
 */
export async function readRepositoryPageManifest(
  root: string,
): Promise<RepositoryPageManifest> {
  const file = repositoryPageManifestPath(root);
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    const manifest = ManifestSchema.parse(parsed);
    assertCanonicalManifestPages(manifest);
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
 * @throws RepositoryRunError when a page path is not canonical and factual.
 */
export async function writeRepositoryPageManifest(
  root: string,
  manifest: RepositoryPageManifest,
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
  assertCanonicalManifestPages(ordered);

  const file = repositoryPageManifestPath(root);
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
 * @returns The durable manifest entry written for the page.
 * @throws RepositoryRunError when the page and Claims sidecar disagree.
 */
export async function recordRepositoryPageCompletion(
  root: string,
  page: string,
  source: RepositorySourceCheckpoint,
  completedBy?: string,
  completedRunId?: string,
): Promise<RepositoryPageManifestEntry> {
  const canonicalPage = normalizeWikiPagePath(page);
  const entry = await buildManifestEntry(
    root,
    canonicalPage,
    source,
    completedBy,
    completedRunId,
  );
  const manifest = await readRepositoryPageManifest(root);
  manifest.pages[canonicalPage] = entry;
  await writeRepositoryPageManifest(root, manifest);
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
 */
export async function seedRepositoryPageManifest(
  root: string,
  pages: readonly string[],
  gitHead: string,
): Promise<void> {
  const manifest = await readRepositoryPageManifest(root);
  let changed = false;
  for (const page of pages) {
    const canonicalPage = normalizeWikiPagePath(page);
    if (manifest.pages[canonicalPage]) continue;
    try {
      manifest.pages[canonicalPage] = await buildManifestEntry(
        root,
        canonicalPage,
        { gitHead },
      );
      changed = true;
    } catch (error) {
      if (!(error instanceof RepositoryRunError)) throw error;
      // Missing coverage deliberately routes this legacy page to full review.
    }
  }
  if (changed) await writeRepositoryPageManifest(root, manifest);
}

/**
 * Replaces coverage with the complete surviving factual page inventory.
 *
 * @param root - Absolute repository root.
 * @param pages - Complete surviving factual page set after finalization.
 * @param source - Source checkpoint proven by successful whole-run finish.
 * @param preservePages - Pages whose prior coverage must remain unchanged.
 */
export async function replaceRepositoryPageManifest(
  root: string,
  pages: readonly string[],
  source: RepositorySourceCheckpoint,
  preservePages: ReadonlySet<string> = new Set(),
): Promise<void> {
  const next = createEmptyRepositoryPageManifest();
  const previous = await readRepositoryPageManifest(root);
  for (const page of pages) {
    const canonicalPage = normalizeWikiPagePath(page);
    if (preservePages.has(canonicalPage)) {
      const previousEntry = previous.pages[canonicalPage];
      if (previousEntry) next.pages[canonicalPage] = previousEntry;
      continue;
    }
    next.pages[canonicalPage] = await buildManifestEntry(
      root,
      canonicalPage,
      source,
      previous.pages[canonicalPage]?.completedBy,
      previous.pages[canonicalPage]?.completedRunId,
    );
  }
  await writeRepositoryPageManifest(root, next);
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
 * @returns Whether the page is durable and current for the checkpoint.
 */
export async function isRepositoryPageCompletionCurrent(
  root: string,
  page: string,
  source: RepositorySourceCheckpoint,
): Promise<boolean> {
  return (
    (await getCurrentRepositoryPageCompletion(root, page, source)) !== null
  );
}

/**
 * Returns current durable completion coverage for one page.
 *
 * @param root - Absolute repository root.
 * @param page - Canonical factual page path.
 * @param source - Exact active-run source checkpoint.
 * @returns Matching verified manifest entry, or `null` when coverage is stale.
 */
export async function getCurrentRepositoryPageCompletion(
  root: string,
  page: string,
  source: RepositorySourceCheckpoint,
): Promise<RepositoryPageManifestEntry | null> {
  if (!source.sourceFingerprint) return null;

  const canonicalPage = normalizeWikiPagePath(page);
  const entry = (await readRepositoryPageManifest(root)).pages[canonicalPage];
  if (!entry || entry.sourceFingerprint !== source.sourceFingerprint) {
    return null;
  }
  if (source.gitHead !== undefined && entry.gitHead !== source.gitHead) {
    return null;
  }
  try {
    const store = new ClaimsStore(root);
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
 * @returns Valid entry bound to the current Markdown bytes.
 * @throws RepositoryRunError when the page is not durably verified.
 */
async function buildManifestEntry(
  root: string,
  page: string,
  source: RepositorySourceCheckpoint,
  completedBy?: string,
  completedRunId?: string,
): Promise<RepositoryPageManifestEntry> {
  const canonicalPage = normalizeWikiPagePath(page);
  const store = new ClaimsStore(root);
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
 * @throws RepositoryRunError when any page key is invalid or non-canonical.
 */
function assertCanonicalManifestPages(manifest: RepositoryPageManifest): void {
  for (const page of Object.keys(manifest.pages)) {
    let canonicalPage: string;
    try {
      canonicalPage = normalizeWikiPagePath(page);
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
