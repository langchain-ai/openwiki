import type { BackendProtocolV2 } from "deepagents";
import { validateWikiMermaid } from "../mermaid/wiki.js";
import {
  deserializeGeneratedProvenance,
  finalizeGeneratedProvenance,
  serializeGeneratedProvenance,
  snapshotGeneratedProvenance,
  type GeneratedProvenanceSnapshot,
  type PersistedGeneratedProvenanceSnapshot,
} from "../okf/generated-provenance.js";
import {
  synchronizeClaimSources,
  type ClaimEvidenceResources,
} from "../okf/claim-sources.js";
import { migrateWikiToOkf, synchronizeWikiIndexes } from "../okf/index-sync.js";
import {
  ENGLISH_CONCEPT_TYPE,
  ENGLISH_INDEX_LABELS,
  type IndexLabels,
} from "../okf/index-labels.js";
import { OPENWIKI_PRODUCER_ACTOR } from "../version.js";
import type { OpenWikiOutputMode } from "./types.js";
import { validateWikiInternalLinks } from "./wiki-link-validator.js";

/**
 * Stable identifiers for deterministic wiki preparation operations.
 */
export type WikiPreparationOperation = "migrate" | "provenance_snapshot";

/**
 * Stable identifiers for deterministic wiki finalization operations.
 */
export type WikiFinalizerOperation =
  | "mermaid"
  | "index_sync"
  | "link_validation"
  | "claims_sources"
  | "generated_provenance";

/**
 * Deferred work for one deterministic wiki lifecycle operation.
 *
 * @typeParam Result - Value produced by the lifecycle operation.
 */
export interface WikiOperationTask<Result> {
  /**
   * Executes the deferred lifecycle operation.
   *
   * @returns Value produced by the operation.
   */
  (): Promise<Result>;
}

/**
 * Runs one named preparation task at the caller's telemetry boundary.
 */
export interface WikiPreparationOperationRunner {
  /**
   * Executes a preparation operation through the caller's wrapper.
   *
   * @param operation - Stable operation identifier used for diagnostics.
   * @param task - Deferred preparation work.
   * @returns Value produced by the preparation operation.
   */
  <Result>(
    operation: WikiPreparationOperation,
    task: WikiOperationTask<Result>,
  ): Promise<Result>;
}

/**
 * Runs one named finalization task at the caller's telemetry boundary.
 */
export interface WikiFinalizerOperationRunner {
  /**
   * Executes a finalization operation through the caller's wrapper.
   *
   * @param operation - Stable operation identifier used for diagnostics.
   * @param task - Deferred finalization work.
   * @returns Value produced by the finalization operation.
   */
  <Result>(
    operation: WikiFinalizerOperation,
    task: WikiOperationTask<Result>,
  ): Promise<Result>;
}

/**
 * Inputs shared by deterministic wiki preparation and finalization.
 */
export interface WikiLifecycleOptions {
  /**
   * Filesystem abstraction rooted to the active wiki target.
   */
  backend: BackendProtocolV2;

  /**
   * Repository or local-wiki output layout.
   */
  outputMode: OpenWikiOutputMode;

  /**
   * Fallback OKF concept type used during migration.
   *
   * @default ENGLISH_CONCEPT_TYPE
   */
  conceptType?: string;
}

/**
 * Inputs required to prepare a wiki before authoring.
 */
export interface WikiPreparationOptions extends WikiLifecycleOptions {
  /**
   * Optional telemetry wrapper for individual preparation operations.
   *
   * @default direct task execution
   */
  runOperation?: WikiPreparationOperationRunner;
}

/**
 * Run-scoped state captured after deterministic preparation.
 */
export interface PreparedWikiState {
  /**
   * Exact pre-authoring body hashes and prior generated events.
   */
  generatedProvenance: GeneratedProvenanceSnapshot;
}

/**
 * JSON-safe deterministic preparation state stored in `.run.json`.
 */
export interface PersistedPreparedWikiState {
  /**
   * Exact pre-authoring provenance baseline used during finalization.
   */
  generatedProvenance: PersistedGeneratedProvenanceSnapshot;
}

/**
 * Serializes the preparation state required by deterministic finalization.
 */
export function serializePreparedWikiState(
  prepared: PreparedWikiState,
): PersistedPreparedWikiState {
  return {
    generatedProvenance: serializeGeneratedProvenance(
      prepared.generatedProvenance,
    ),
  };
}

/**
 * Recreates deterministic finalization state after process restart.
 */
export function deserializePreparedWikiState(
  persisted: PersistedPreparedWikiState,
): PreparedWikiState {
  return {
    generatedProvenance: deserializeGeneratedProvenance(
      persisted.generatedProvenance,
    ),
  };
}

/**
 * Inputs required to finalize a prepared wiki after authoring.
 */
export interface WikiFinalizerOptions extends WikiLifecycleOptions {
  /**
   * Localized labels used by generated indexes.
   *
   * @default ENGLISH_INDEX_LABELS
   */
  labels?: IndexLabels;

  /**
   * State returned by the matching preparation call.
   */
  prepared: PreparedWikiState;

  /**
   * ISO 8601 timestamp shared by generated provenance events for this run.
   */
  at: string;

  /**
   * Producer responsible for authored body changes in this run.
   *
   * @default OPENWIKI_PRODUCER_ACTOR - the native OpenWiki agent authored the
   * changed prose.
   */
  producerActor?: string;

  /**
   * Current page-owned Claims evidence projected into OKF sources before
   * generated provenance is reconciled.
   *
   * @default undefined - no Claims source projection is required.
   */
  claimSources?: ClaimEvidenceResources;

  /**
   * Optional telemetry wrapper for individual finalization operations.
   *
   * @default direct task execution
   */
  runOperation?: WikiFinalizerOperationRunner;
}

/**
 * Migrates existing concepts and captures their pre-authoring provenance.
 *
 * @param options - Preparation inputs for the active wiki.
 * @returns Run-scoped state required by finalization.
 */
export async function prepareWikiForAuthoring({
  backend,
  outputMode,
  conceptType = ENGLISH_CONCEPT_TYPE,
  runOperation = runWikiOperation,
}: WikiPreparationOptions): Promise<PreparedWikiState> {
  await runOperation("migrate", () =>
    migrateWikiToOkf(backend, outputMode, conceptType),
  );
  return {
    generatedProvenance: await runOperation("provenance_snapshot", () =>
      snapshotGeneratedProvenance(backend, outputMode),
    ),
  };
}

/**
 * Runs deterministic post-authoring validation, index synchronization, and
 * generated-provenance reconciliation in internal-agent order.
 *
 * @param options - Finalization inputs and matching preparation state.
 */
export async function finalizeWikiArtifacts({
  backend,
  outputMode,
  labels = ENGLISH_INDEX_LABELS,
  conceptType = ENGLISH_CONCEPT_TYPE,
  prepared,
  at,
  producerActor = OPENWIKI_PRODUCER_ACTOR,
  claimSources,
  runOperation = runWikiOperation,
}: WikiFinalizerOptions): Promise<void> {
  if (producerActor.trim().length === 0) {
    throw new Error("Wiki finalization requires a non-empty producer actor.");
  }
  await runOperation("mermaid", () => validateWikiMermaid(backend, outputMode));
  await runOperation("index_sync", () =>
    synchronizeWikiIndexes(backend, outputMode, labels, conceptType),
  );
  await runOperation("link_validation", () =>
    validateWikiInternalLinks(backend, outputMode),
  );
  if (claimSources) {
    await runOperation("claims_sources", () =>
      synchronizeClaimSources(backend, outputMode, claimSources),
    );
  }
  await runOperation("generated_provenance", () =>
    finalizeGeneratedProvenance(
      backend,
      outputMode,
      prepared.generatedProvenance,
      at,
      producerActor,
    ),
  );
}

/**
 * Executes a lifecycle operation directly when no caller wrapper is supplied.
 *
 * @param _operation - Stable operation identifier, unused without a wrapper.
 * @param task - Deferred lifecycle work.
 * @returns Value produced by the lifecycle operation.
 */
async function runWikiOperation<Result>(
  _operation: WikiPreparationOperation | WikiFinalizerOperation,
  task: WikiOperationTask<Result>,
): Promise<Result> {
  return task();
}
