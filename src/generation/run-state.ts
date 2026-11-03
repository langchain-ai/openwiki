import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PersistedPreparedWikiState } from "../agent/wiki-finalizer.js";
import type { UpdateMetadata } from "../agent/types.js";
import { normalizeWikiPagePath } from "../claims/brains/code/paths.js";
import { isFileNotFoundError } from "../platform/fs-errors.js";
import {
  DEFAULT_REPOSITORY_WIKI_DIRECTORY,
  RepositoryWikiPaths,
  resolveRepositoryWikiRoot,
} from "../repository-wiki/paths.js";
import { RepositoryRunError } from "./errors.js";

/**
 * Backward-compatible path policy for unconfigured repository wikis.
 */
const DEFAULT_RUN_STATE_WIKI_PATHS = new RepositoryWikiPaths(
  DEFAULT_REPOSITORY_WIKI_DIRECTORY,
);

/**
 * Basename of the one durable repository-generation checkpoint.
 */
export const REPOSITORY_RUN_STATE_BASENAME = ".run.json";

/**
 * Current on-disk repository-run schema version.
 */
export const REPOSITORY_RUN_STATE_SCHEMA_VERSION = 1 as const;

/**
 * Repository generation commands supported by the durable lifecycle.
 */
export type RepositoryRunMode = "init" | "update";

/**
 * Persisted high-level lifecycle phase.
 */
export type RepositoryRunPhase = "planning" | "generating";

/**
 * Persisted completion state for one ordered page job.
 */
export type PageJobStatus = "pending" | "skipped" | "complete";

/**
 * Current producer and metadata identities for repository generation.
 */
export interface RepositoryRunActor {
  /**
   * Provenance actor used for page work performed by the current session.
   */
  producerActor: string;

  /**
   * Model/host identity written to `.last-update.json`.
   */
  metadataModel: string;
}

/**
 * One normalized unit of sequential semantic page work.
 */
export interface PageJob {
  /**
   * Stable identifier used by `submit_page`.
   */
  id: string;

  /**
   * Canonical actual Markdown path below the configured wiki root.
   */
  path: string;

  /**
   * Human-readable page title supplied by the normalized plan.
   */
  title: string;

  /**
   * Page-specific documentation objective supplied to its worker.
   */
  purpose: string;

  /**
   * Repository-relative starting points, not research boundaries.
   */
  seedPaths: string[];

  /**
   * Canonical generated pages relevant to this job.
   */
  relatedPages: string[];

  /**
   * Relevant global planning constraints propagated to this page.
   */
  instructions: string[];

  /**
   * Durable completion state for this queue entry.
   */
  status: PageJobStatus;

  /**
   * Producer that durably completed this page.
   *
   * @default undefined for pending/skipped jobs and legacy completed state.
   */
  completedBy?: string;
}

/**
 * Complete normalized plan persisted as the run's ordered queue.
 */
export interface RepositoryRunPlan {
  /**
   * Complete ordered queue of normalized page jobs.
   */
  pages: PageJob[];

  /**
   * Existing pages explicitly selected for deletion by an update.
   */
  deletePages: string[];
}

/**
 * Complete JSON checkpoint required to resume repository generation.
 */
export interface RepositoryRunState {
  /**
   * On-disk schema discriminator for this checkpoint.
   */
  schemaVersion: 1;

  /**
   * Stable UUID used to address this resumable run.
   */
  runId: string;

  /**
   * Repository generation command that created the run.
   */
  mode: RepositoryRunMode;

  /**
   * Current persisted lifecycle phase.
   */
  phase: RepositoryRunPhase;

  /**
   * ISO timestamp captured when the run first began.
   */
  startedAt: string;

  /**
   * Resolved documentation language for the run.
   */
  language: string;

  /**
   * Whether the resolved language differs from the previous successful run.
   */
  languageChanged: boolean;

  /**
   * Existing pages that must be rewritten after a language change.
   */
  requiredRewritePages: string[];

  /**
   * Factual pages present before this run began semantic generation.
   */
  initialPages: string[];

  /**
   * SHA-256 identity of the source input for the active plan.
   */
  sourceFingerprint: string;

  /**
   * Git HEAD paired with `sourceFingerprint` for the active semantic plan.
   *
   * @default undefined for an unborn repository.
   */
  targetGitHead?: string;

  /**
   * Actual user/connector context needed for planning and replanning.
   */
  planningContext?: string;

  /**
   * Current producer and metadata identities, refreshed on resume.
   */
  actor: RepositoryRunActor;

  /**
   * Successful metadata that existed before this run marked itself interrupted.
   */
  previousLastUpdate: UpdateMetadata | null;

  /**
   * Git HEAD recorded by the prior successful repository update.
   */
  baseGitHead?: string;

  /**
   * Repository-level OpenWiki instructions loaded when the run began.
   */
  wikiGoal?: string;

  /**
   * Pre-run OpenWiki content snapshot used for final change detection.
   */
  beforeContentSnapshot: string;

  /**
   * Serialized preparation state required for deterministic finalization.
   */
  preparedWiki: PersistedPreparedWikiState;

  /**
   * Active normalized plan, absent while planning or after invalidation.
   */
  plan?: RepositoryRunPlan;
}

/**
 * Runtime validator for persisted repository update metadata.
 */
const UpdateMetadataSchema = z
  .object({
    updatedAt: z.string(),
    command: z.enum(["init", "update"]),
    gitHead: z.string().optional(),
    model: z.string(),
    status: z.enum(["complete", "interrupted"]),
    language: z.string().optional(),
  })
  .strict();

/**
 * Runtime validator for serialized deterministic wiki preparation state.
 */
const PersistedPreparedWikiStateSchema = z
  .object({
    generatedProvenance: z.array(
      z
        .object({
          page: z.string().min(1),
          bodyHash: z.string().min(1),
          generated: z
            .object({
              by: z.string().min(1),
              at: z.string().min(1).optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
  })
  .strict();

/**
 * Runtime validator for one durable page job.
 */
const PageJobSchema = z
  .object({
    id: z.string().uuid(),
    path: z.string().min(1),
    title: z.string().trim().min(1),
    purpose: z.string().trim().min(1),
    seedPaths: z.array(z.string()),
    relatedPages: z.array(z.string()),
    instructions: z.array(z.string().trim().min(1)),
    status: z.enum(["pending", "skipped", "complete"]),
    completedBy: z.string().trim().min(1).optional(),
  })
  .strict();

/**
 * Runtime validator for one complete durable repository run checkpoint.
 */
const RepositoryRunStateSchema = z
  .object({
    schemaVersion: z.literal(REPOSITORY_RUN_STATE_SCHEMA_VERSION),
    runId: z.string().uuid(),
    mode: z.enum(["init", "update"]),
    phase: z.enum(["planning", "generating"]),
    startedAt: z.string().min(1),
    language: z.string().min(1),
    languageChanged: z.boolean(),
    requiredRewritePages: z.array(z.string().min(1)),
    initialPages: z.array(z.string().min(1)),
    sourceFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    targetGitHead: z.string().min(1).optional(),
    planningContext: z.string().min(1).optional(),
    actor: z
      .object({
        producerActor: z.string().trim().min(1),
        metadataModel: z.string().trim().min(1),
      })
      .strict(),
    previousLastUpdate: UpdateMetadataSchema.nullable(),
    baseGitHead: z.string().min(1).optional(),
    wikiGoal: z.string().optional(),
    beforeContentSnapshot: z.string(),
    preparedWiki: PersistedPreparedWikiStateSchema,
    plan: z
      .object({
        pages: z.array(PageJobSchema),
        deletePages: z.array(z.string()),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Resolves the checkpoint path below the configured repository wiki root.
 *
 * @param root - Absolute repository root.
 * @param wikiPaths - Canonical physical repository wiki path policy.
 * @returns Absolute durable checkpoint path.
 */
export function repositoryRunStatePath(
  root: string,
  wikiPaths: RepositoryWikiPaths = DEFAULT_RUN_STATE_WIKI_PATHS,
): string {
  return path.join(
    resolveRepositoryWikiRoot(root, wikiPaths.directory),
    REPOSITORY_RUN_STATE_BASENAME,
  );
}

/**
 * Loads and validates resumable state.
 *
 * @param root - Absolute repository root.
 * @param wikiPaths - Canonical physical repository wiki path policy.
 * @returns Valid state, or `null` when no checkpoint exists.
 * @throws RepositoryRunError when the checkpoint is malformed.
 */
export async function readRepositoryRunState(
  root: string,
  wikiPaths: RepositoryWikiPaths = DEFAULT_RUN_STATE_WIKI_PATHS,
): Promise<RepositoryRunState | null> {
  const file = repositoryRunStatePath(root, wikiPaths);
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    const state = RepositoryRunStateSchema.parse(parsed);
    assertRepositoryRunStatePaths(state, wikiPaths);
    return state;
  } catch (error) {
    if (isFileNotFoundError(error)) return null;

    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new RepositoryRunError(
        "invalid_state",
        `OpenWiki run state is malformed at ${file}; refusing to discard resumable work.`,
      );
    }
    throw error;
  }
}

/**
 * Atomically replaces the complete repository-generation checkpoint.
 *
 * @param root - Absolute repository root.
 * @param state - Complete validated durable run state.
 * @param wikiPaths - Canonical physical repository wiki path policy.
 * @throws Error when validation or filesystem persistence fails.
 */
export async function writeRepositoryRunState(
  root: string,
  state: RepositoryRunState,
  wikiPaths: RepositoryWikiPaths = DEFAULT_RUN_STATE_WIKI_PATHS,
): Promise<void> {
  RepositoryRunStateSchema.parse(state);
  assertRepositoryRunStatePaths(state, wikiPaths);
  const file = repositoryRunStatePath(root, wikiPaths);
  await mkdir(path.dirname(file), { recursive: true });

  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Idempotently removes the checkpoint after completion or init rollback.
 *
 * @param root - Absolute repository root.
 * @param wikiPaths - Canonical physical repository wiki path policy.
 */
export async function removeRepositoryRunState(
  root: string,
  wikiPaths: RepositoryWikiPaths = DEFAULT_RUN_STATE_WIKI_PATHS,
): Promise<void> {
  await rm(repositoryRunStatePath(root, wikiPaths), { force: true });
}

/**
 * Rejects durable page identities outside the configured repository wiki root.
 */
function assertRepositoryRunStatePaths(
  state: RepositoryRunState,
  wikiPaths: RepositoryWikiPaths,
): void {
  const factualPages = [
    ...state.requiredRewritePages,
    ...state.initialPages,
    ...(state.plan?.deletePages ?? []),
    ...(state.plan?.pages.flatMap((page) => [
      page.path,
      ...page.relatedPages,
    ]) ?? []),
  ];
  for (const page of factualPages) {
    assertCanonicalRunPage(page, wikiPaths, true);
  }
  for (const page of state.preparedWiki.generatedProvenance.map(
    ({ page }) => page,
  )) {
    assertCanonicalRunPage(page, wikiPaths, false);
  }
}

/**
 * Rejects one non-canonical or out-of-root durable page identity.
 */
function assertCanonicalRunPage(
  page: string,
  wikiPaths: RepositoryWikiPaths,
  factual: boolean,
): void {
  try {
    const canonical = factual
      ? normalizeWikiPagePath(page, wikiPaths)
      : wikiPaths.normalizePage(page);
    if (canonical !== page) throw new Error("non-canonical page");
  } catch {
    throw new RepositoryRunError(
      "invalid_state",
      `OpenWiki run state contains a page outside ${wikiPaths.canonicalRoot}: ${page}`,
    );
  }
}
