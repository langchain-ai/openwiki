import { createHash } from "node:crypto";

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { EvaluationError } from "../core/errors.js";
import { compareStrings } from "../core/order.js";
import type {
  EvidenceCorpus,
  EvaluationWarning,
  PrecisionAssertionEvaluation,
  PrecisionClaimTense,
} from "../core/types.js";
import { invokeStructuredModel } from "./direct-model.js";
import type { ArtifactSection } from "./documents.js";
import {
  assertPositiveInteger,
  batch,
  createLimiter,
  DEFAULT_PASS_CONCURRENCY,
  mapWithLimit,
  type Limiter,
} from "./pass-utils.js";
import {
  PRECISION_EXTRACTION_SYSTEM,
  PRECISION_HISTORY_JUDGMENT_SYSTEM,
  PRECISION_JUDGMENT_SYSTEM,
  precisionExtractionPrompt,
  precisionJudgmentPrompt,
  type PrecisionArtifactContext,
  type PrecisionEvidenceExcerpt,
  type PrecisionExtractionUnit,
  type PrecisionJudgmentAssertion,
} from "./prompts.js";
import { SectionBm25Index } from "./retrieval.js";
import {
  SemanticEvidenceRouter,
  type EvidenceMapMatch,
  type ResolvedEvidenceMapMatch,
} from "./evidence-map.js";
import {
  assertionExtractionOutputSchema,
  precisionJudgmentBatchOutputSchema,
  precisionJudgmentOutputSchema,
  type AssertionExtractionOutput,
  type PrecisionJudgmentOutput,
} from "./schemas.js";

/**
 * Default number of text units classified per extraction request.
 *
 * Sized larger than the judgment default because extraction units are compact
 * (a claim plus its grounding pointer), so they hit the structured-output
 * ceiling later. Fewer, larger batches cut serial round-trips per checkpoint,
 * and a degenerate batch now degrades to per-item repair rather than aborting.
 */
const DEFAULT_EXTRACTION_BATCH_SIZE = 25;

/**
 * Default number of assertions grounded per judgment request.
 *
 * Kept below the extraction default because judgments are rationale-first, so
 * each unit's output is heavier and truncates sooner at large batch sizes.
 */
const DEFAULT_JUDGMENT_BATCH_SIZE = 15;

/** Minimum ranked excerpts retained even when they exceed the soft budget. */
const MIN_EVIDENCE_SECTIONS = 8;

/**
 * Soft per-assertion source-evidence budget. Small corpora fit in full; larger
 * ones retain mandatory structural evidence plus at least the top ranked set.
 */
const EVIDENCE_CHAR_BUDGET = 24_000;

/**
 * A precision grounding verdict stripped of its checkpoint-specific location, so
 * it can be reused for an identical claim grounded on identical evidence at a
 * later checkpoint. The statement, tense, and grounding-evidence signature are
 * folded into the cache key rather than stored here, so only the verdict payload
 * remains.
 */
export interface CachedPrecisionVerdict {
  /**
   * Source-grounding verdict reached for the claim.
   */
  verdict: PrecisionAssertionEvaluation["verdict"];

  /**
   * Which stage adjudicated the verdict.
   */
  adjudicatedBy: PrecisionAssertionEvaluation["adjudicatedBy"];

  /**
   * Evidence identifiers the verdict cited, all drawn from the claim's own
   * grounding evidence set.
   */
  evidenceIds: string[];

  /**
   * Judge rationale recorded for the verdict.
   */
  rationale: string;
}

/**
 * Cross-checkpoint precision verdict cache, keyed by a stable hash of the claim
 * statement, tense, and grounding-evidence content signature. Owned by the
 * evaluation backend so it persists across a run's checkpoints; a claim whose
 * text and grounding evidence are unchanged from an earlier checkpoint reuses
 * the earlier verdict instead of being re-judged.
 */
export type PrecisionVerdictCache = Map<string, CachedPrecisionVerdict>;

/**
 * One extracted artifact claim carried through the source-grounding pass.
 */
export interface ExtractedArtifactAssertion {
  /**
   * Stable per-checkpoint assertion identifier.
   */
  id: string;

  /**
   * Normalized claim text as it appears in the artifact.
   */
  statement: string;

  /** Exact contiguous artifact text supporting the normalized statement. */
  sourceQuote: string;

  /** Stable identity of the full text unit that constrains the quote. */
  unitId: string;

  /** Exact full text unit used to interpret scope and tense. */
  artifactContext: string;

  /** Active heading hierarchy at the assertion's location. */
  headingPath: string[];

  /**
   * Whether the claim is asserted as current or historical truth.
   */
  tense: PrecisionClaimTense;

  /**
   * Artifact section the claim was extracted from.
   */
  sectionId: string;

  /**
   * Path of the source document relative to the artifact root.
   */
  relativePath: string;
}

/**
 * How the extractor classified one Markdown text unit.
 */
export type PrecisionTextUnitClassification =
  | "factual"
  | "mixed"
  | "navigation"
  | "meta-artifact"
  | "opinion"
  | "instruction"
  | "no-claim";

/**
 * One candidate assertion in the inventory, recording whether it was kept as a
 * distinct claim or excluded as an exact duplicate of an earlier candidate.
 */
export interface PrecisionAssertionInventoryEntry {
  /**
   * Stable per-checkpoint candidate identifier in extraction order.
   */
  candidateId: string;

  /**
   * Normalized claim text.
   */
  statement: string;

  /** Exact artifact span from which the statement was normalized. */
  sourceQuote: string;

  /**
   * Whether the claim is asserted as current or historical truth.
   */
  tense: PrecisionClaimTense;

  /**
   * Artifact section the claim was extracted from.
   */
  sectionId: string;

  /**
   * Path of the source document relative to the artifact root.
   */
  relativePath: string;

  /**
   * Active ATX heading hierarchy at the claim's location.
   */
  headingPath: string[];

  /**
   * Whether this candidate became a distinct assertion or was dropped.
   */
  disposition: "kept" | "excluded";

  /**
   * Assertion identifier assigned when the candidate is kept.
   *
   * @default undefined when the candidate was excluded
   */
  assertionId?: string;

  /**
   * Why the candidate was excluded.
   *
   * @default undefined when the candidate was kept
   */
  exclusionReason?: "exact-duplicate";

  /**
   * Candidate identifier this one duplicates.
   *
   * @default undefined when the candidate was kept
   */
  duplicateOf?: string;
}

/**
 * One classified Markdown text unit and the claims extracted from it.
 */
export interface PrecisionTextUnitInventoryEntry {
  /**
   * Stable per-section text-unit identifier.
   */
  unitId: string;

  /**
   * Artifact section the unit belongs to.
   */
  sectionId: string;

  /**
   * Path of the source document relative to the artifact root.
   */
  relativePath: string;

  /**
   * Active ATX heading hierarchy at the unit's location.
   */
  headingPath: string[];

  /**
   * Exact Markdown assigned to the unit.
   */
  content: string;

  /**
   * Extractor classification of the unit.
   */
  classification: PrecisionTextUnitClassification;

  /**
   * Claims extracted from the unit, if any.
   */
  assertions: Array<{
    statement: string;
    sourceQuote: string;
    tense: PrecisionClaimTense;
  }>;

  /**
   * Extractor rationale for the classification.
   */
  rationale: string;
}

/**
 * Full record of extraction and deduplication for one checkpoint.
 */
export interface PrecisionAssertionInventory {
  /**
   * Checkpoint the inventory was built for.
   */
  checkpointId: string;

  /**
   * Number of artifact sections presented to extraction.
   */
  totalSectionCount: number;

  /**
   * Number of sections extraction actually processed.
   */
  extractedSectionCount: number;

  /**
   * Every classified text unit in stable order.
   */
  units: PrecisionTextUnitInventoryEntry[];

  /**
   * Every candidate assertion, kept or excluded, in extraction order.
   */
  candidates: PrecisionAssertionInventoryEntry[];

  /** Evidence selected for every kept assertion, including cache provenance. */
  groundingEvidence: PrecisionGroundingEvidenceInventoryEntry[];

  /**
   * Number of distinct assertions kept for accounting.
   */
  keptAssertionCount: number;
}

/** Auditable evidence selection for one distinct assertion. */
export interface PrecisionGroundingEvidenceInventoryEntry {
  /** Stable assertion identity from the candidate inventory. */
  assertionId: string;

  /** Current source excerpts supplied to current-state grounding. */
  currentEvidenceIds: string[];

  /** Historical candidates reserved for a possible former-truth follow-up. */
  historicalEvidenceIds: string[];

  /** Semantic evidence-map routes matched to this assertion. */
  evidenceMapEntryIds: string[];

  /** Selectors contributed by the matched routes. */
  evidenceMapSelectors: string[];

  /** Current source files resolved through the evidence map. */
  currentEvidenceMapSourceRefs: string[];

  /** Historical source files resolved through the evidence map. */
  historicalEvidenceMapSourceRefs: string[];

  /** Whether historical candidates were actually supplied to a judgment. */
  historicalConsulted: boolean;

  /** Whether the final verdict was reused without a fresh grounding call. */
  cacheHit: boolean;
}

/**
 * Inputs for one checkpoint's precision pass.
 */
export interface PrecisionPassInput {
  /**
   * Evaluator model used for extraction and source grounding.
   */
  model: BaseChatModel;

  /**
   * Checkpoint being evaluated.
   */
  checkpointId: string;

  /**
   * Markdown artifact sections to extract claims from.
   */
  sections: ArtifactSection[];

  /**
   * Source evidence corpus every claim is grounded against. Current records are
   * judged first. Prior checkpoints are marked historical (`current: false`)
   * and are consulted only to split a current contradiction into stale versus
   * invented.
   */
  evidence: EvidenceCorpus;

  /** Optional evaluator-only natural-language topic to source routing map. */
  evidenceMap?: import("../core/types.js").SemanticEvidenceMap;

  /**
   * Number of text units classified per extraction request.
   *
   * @default 25
   */
  extractionBatchSize?: number;

  /**
   * Number of assertions grounded per judgment request.
   *
   * @default 15
   */
  judgmentBatchSize?: number;

  /**
   * Per-attempt evaluator request deadline in milliseconds.
   *
   * @default undefined no per-attempt deadline is applied
   */
  timeoutMs?: number;

  /**
   * Shared concurrency limiter bounding in-flight model calls across passes.
   *
   * @default a private limiter of `DEFAULT_PASS_CONCURRENCY` when absent, so a
   * standalone pass still runs its extraction and judgment batches concurrently
   * but never shares a budget with sibling passes.
   */
  limit?: Limiter;

  /**
   * Cross-checkpoint precision verdict cache. When supplied, an assertion whose
   * statement, tense, and per-assertion grounding evidence match an earlier
   * checkpoint's entry reuses that verdict instead of being re-judged, and every
   * fresh non-degraded verdict is written back for later checkpoints.
   *
   * @default undefined every assertion is judged fresh and nothing is cached, so
   * a standalone pass is fully self-contained.
   */
  verdictCache?: PrecisionVerdictCache;

  /**
   * Optional sink for the assertion inventory once extraction completes.
   *
   * @default undefined the inventory is not surfaced
   */
  onInventory?: (
    inventory: PrecisionAssertionInventory,
  ) => void | Promise<void>;

  /** Optional sink for completed text-unit extraction work. */
  onExtractionProgress?: (completed: number, total: number) => void;

  /** Optional sink for completed distinct-assertion grounding work. */
  onGroundingProgress?: (completed: number, total: number) => void;

  /**
   * Optional sink for items that remain invalid after isolated repair.
   *
   * @default undefined evaluator warnings are dropped
   */
  onWarning?: (warning: EvaluationWarning) => void;
}

/**
 * One assertion extracted from a text unit before deduplication.
 */
interface RawExtractedAssertion {
  /**
   * Normalized claim text.
   */
  statement: string;

  /** Exact artifact span from which the statement was normalized. */
  sourceQuote: string;

  /** Stable identity of the complete originating text unit. */
  unitId: string;

  /** Exact complete text unit constraining scope and tense. */
  artifactContext: string;

  /**
   * Whether the claim is asserted as current or historical truth.
   */
  tense: PrecisionClaimTense;

  /**
   * Artifact section the claim was extracted from.
   */
  sectionId: string;

  /**
   * Path of the source document relative to the artifact root.
   */
  relativePath: string;

  /**
   * Active ATX heading hierarchy at the claim's location.
   */
  headingPath: string[];
}

/**
 * A Markdown text unit presented to the extraction classifier.
 */
type PrecisionTextUnit = PrecisionExtractionUnit;

/**
 * A text unit paired with its extractor classification and claims.
 */
interface ClassifiedPrecisionTextUnit extends PrecisionTextUnit {
  /**
   * Extractor classification of the unit.
   */
  classification: PrecisionTextUnitClassification;

  /**
   * Claims extracted from the unit, if any.
   */
  assertions: Array<{
    statement: string;
    sourceQuote: string;
    tense: PrecisionClaimTense;
  }>;

  /**
   * Extractor rationale for the classification.
   */
  rationale: string;
}

/**
 * A source-evidence section annotated with its checkpoint provenance.
 */
interface EvidenceSection extends ArtifactSection {
  /**
   * Checkpoint at which the evidence was observed.
   */
  observedAtCheckpoint: string;

  /**
   * Whether the evidence is current source truth.
   */
  current: boolean;
}

/**
 * One assertion paired with the evidence visible to its grounding judgment.
 */
interface PrecisionJudgmentTarget {
  /**
   * Assertion being grounded against source evidence.
   */
  assertion: ExtractedArtifactAssertion;

  /**
   * Candidate evidence sections for the grounding judgment.
   */
  evidence: EvidenceSection[];
}

/**
 * Normalize assertion whitespace without changing factual content.
 */
function normalizeStatement(statement: string): string {
  return statement.replace(/\s+/gu, " ").trim();
}

/**
 * Produce the conservative exact-deduplication key.
 */
function deduplicationKey(statement: string): string {
  return statement
    .toLocaleLowerCase("en-US")
    .replace(/[`'"“”‘’]/gu, "")
    .replace(/[^a-z0-9_+.-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/[.!?;:]+$/u, "")
    .trim();
}

/**
 * Divide a Markdown section into stable blank-line-delimited blocks.
 */
function textUnitsForSection(section: ArtifactSection): PrecisionTextUnit[] {
  const lines = section.content.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const blocks: string[] = [];
  let current = "";
  let fence: { marker: "`" | "~"; length: number } | undefined;

  const flush = (): void => {
    if (current.length > 0) {
      blocks.push(current);
      current = "";
    }
  };

  for (const line of lines) {
    const withoutNewline = line.replace(/\r?\n$/u, "");
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(withoutNewline)?.[1];
    if (fence === undefined && marker !== undefined) {
      fence = { marker: marker[0] as "`" | "~", length: marker.length };
    } else if (
      fence !== undefined &&
      marker?.[0] === fence.marker &&
      marker.length >= fence.length &&
      /^ {0,3}(?:`{3,}|~{3,})[\t ]*$/u.test(withoutNewline)
    ) {
      fence = undefined;
    }

    if (fence === undefined && withoutNewline.trim().length === 0) {
      flush();
    } else {
      current += line;
    }
  }
  flush();
  if (blocks.length === 0) blocks.push("");

  // A prose lead-in ending in a colon gives the following Markdown list its
  // subject and scope. Keeping them together prevents deictic list text such as
  // "this file" or "the following" from losing the antecedent the extractor
  // needs to produce a self-contained claim.
  const contextualBlocks: string[] = [];
  for (const block of blocks) {
    const previous = contextualBlocks.at(-1);
    const startsList = /^(?: {0,3}(?:[-+*]|\d+[.)])[	 ]+)/u.test(block);
    if (previous !== undefined && /:\s*$/u.test(previous) && startsList) {
      const separator = previous.endsWith("\n") ? "\n" : "\n\n";
      contextualBlocks[contextualBlocks.length - 1] =
        previous + separator + block;
    } else {
      contextualBlocks.push(block);
    }
  }

  return contextualBlocks.map((content, index) => ({
    unitId: `${section.id}::unit-${String(index).padStart(4, "0")}`,
    sectionId: section.id,
    relativePath: section.relativePath,
    headingPath: section.headingPath,
    content,
  }));
}

/**
 * Resolve one requested text unit from raw extraction output, rejecting a
 * missing, duplicated, or classification-inconsistent response for that unit.
 * Extra units the model returned for identifiers that were not requested are
 * ignored rather than treated as fatal.
 *
 * @param unit - The requested text unit to resolve.
 * @param output - Raw extraction output that should classify the unit.
 *
 * @returns The unit paired with its classification and normalized assertions.
 *
 * @throws EvaluationError when the output does not classify the unit exactly
 *   once, or the classification and its assertions are inconsistent.
 */
function resolveExtractionUnit(
  unit: PrecisionTextUnit,
  output: AssertionExtractionOutput,
): ClassifiedPrecisionTextUnit {
  const matches = output.units.filter(
    (result) => result.unitId === unit.unitId,
  );
  if (matches.length !== 1) {
    throw new EvaluationError(
      `Precision extractor returned ${matches.length} results for unitId "${unit.unitId}".`,
    );
  }
  const [result] = matches;
  const yieldsClaims =
    result.classification === "factual" || result.classification === "mixed";
  if (yieldsClaims !== result.assertions.length > 0) {
    throw new EvaluationError(
      `Precision extractor returned classification "${result.classification}" with ${result.assertions.length} assertions for unitId "${unit.unitId}".`,
    );
  }
  for (const assertion of result.assertions) {
    if (
      deduplicationKey(normalizeStatement(assertion.statement)).length === 0
    ) {
      throw new EvaluationError(
        `Precision extractor returned an empty assertion for unitId "${unit.unitId}".`,
      );
    }
    if (!unit.content.includes(assertion.sourceQuote)) {
      throw new EvaluationError(
        `Precision extractor returned a sourceQuote that does not appear verbatim in unitId "${unit.unitId}".`,
      );
    }
  }
  return {
    ...unit,
    classification: result.classification,
    assertions: result.assertions.map((assertion) => ({
      statement: normalizeStatement(assertion.statement),
      sourceQuote: assertion.sourceQuote,
      tense: assertion.tense,
    })),
    rationale: result.rationale,
  };
}

/**
 * Re-extract a single text unit in isolation, giving the model a clean retry
 * when it dropped or mishandled the unit inside a larger batch.
 *
 * @param input - The precision pass input carrying the model and timeout.
 * @param unit - The single text unit to re-extract.
 *
 * @returns The classified unit.
 */
async function repairExtractionUnit(
  input: PrecisionPassInput,
  unit: PrecisionTextUnit,
): Promise<ClassifiedPrecisionTextUnit> {
  const output = await invokeStructuredModel({
    model: input.model,
    pass: "precision-extraction",
    checkpointId: input.checkpointId,
    systemPrompt: PRECISION_EXTRACTION_SYSTEM,
    taskPrompt: precisionExtractionPrompt([unit]),
    schema: assertionExtractionOutputSchema,
    validate: (parsed) => resolveExtractionUnit(unit, parsed),
    timeoutMs: input.timeoutMs,
  });
  return resolveExtractionUnit(unit, output);
}

/**
 * Fall back to a claim-free classification for a text unit the extractor could
 * not process even in isolation. The unit contributes no assertions, so it can
 * never fabricate precision signal; the failure is surfaced through an
 * evaluator warning instead of crashing the run.
 *
 * @param unit - The text unit that could not be extracted.
 * @param message - Combined batch and isolated-repair failure detail.
 *
 * @returns A no-claim classified unit recording the evaluator failure.
 */
function degradedExtractionUnit(
  unit: PrecisionTextUnit,
  message: string,
): ClassifiedPrecisionTextUnit {
  return {
    ...unit,
    classification: "no-claim",
    assertions: [],
    rationale: `Evaluator could not extract assertions: ${message}`,
  };
}

/**
 * Classify one batch of text units, resolving each requested unit individually
 * so a single dropped or malformed unit is repaired in isolation and, only if
 * that also fails, degraded to a warned no-claim unit rather than failing the
 * batch. Returns the classified units in the batch's input order.
 *
 * @param input - Precision pass configuration and warning sink.
 * @param unitBatch - Text units classified in one model request.
 *
 * @returns One classified unit per input unit, in order.
 */
async function classifyUnitBatch(
  input: PrecisionPassInput,
  unitBatch: PrecisionTextUnit[],
): Promise<ClassifiedPrecisionTextUnit[]> {
  // A whole-batch extraction failure (for example an empty or malformed
  // tool-call payload that survives both attempts inside
  // invokeStructuredModel) must not abort the pass. Fall back to an empty
  // response and let the per-unit loop below re-extract each unit in
  // isolation, degrading only the units that still cannot be extracted. The
  // batch error is threaded into the degrade message so the warning reports
  // the real cause; the error is already prompt-redacted and length-bounded
  // by invokeStructuredModel before it reaches here.
  let output: AssertionExtractionOutput;
  let batchError: unknown;
  try {
    output = await invokeStructuredModel({
      model: input.model,
      pass: "precision-extraction",
      checkpointId: input.checkpointId,
      systemPrompt: PRECISION_EXTRACTION_SYSTEM,
      taskPrompt: precisionExtractionPrompt(unitBatch),
      schema: assertionExtractionOutputSchema,
      timeoutMs: input.timeoutMs,
    });
  } catch (error) {
    batchError = error;
    output = { units: [] };
  }
  const classified: ClassifiedPrecisionTextUnit[] = [];
  for (const unit of unitBatch) {
    try {
      classified.push(resolveExtractionUnit(unit, output));
    } catch (initialError) {
      try {
        classified.push(await repairExtractionUnit(input, unit));
      } catch (repairError) {
        const cause = batchError ?? initialError;
        const message = `${String(cause)} Isolated repair failed: ${String(repairError)}`;
        input.onWarning?.({
          pass: "precision-extraction",
          itemId: unit.unitId,
          message,
        });
        classified.push(degradedExtractionUnit(unit, message));
      }
    }
  }
  return classified;
}

/**
 * Classify every section's text units and flatten the extracted claims. Unit
 * batches run concurrently under the shared limiter and are reassembled in batch
 * order, so extraction order (hence candidate identifiers) is unchanged from a
 * serial drain. Each requested unit is still resolved, repaired, or degraded
 * individually within its batch.
 */
async function extractAssertions(
  input: PrecisionPassInput,
  sections: ArtifactSection[],
  batchSize: number,
  limit: Limiter,
): Promise<{
  units: PrecisionTextUnitInventoryEntry[];
  assertions: RawExtractedAssertion[];
}> {
  const units = sections.flatMap(textUnitsForSection);
  let completed = 0;
  input.onExtractionProgress?.(completed, units.length);
  const batchResults = await mapWithLimit(
    batch(units, batchSize),
    limit,
    async (unitBatch) => {
      const result = await classifyUnitBatch(input, unitBatch);
      completed += unitBatch.length;
      input.onExtractionProgress?.(completed, units.length);
      return result;
    },
  );
  const classified = batchResults.flat();

  return {
    units: classified.map((unit) => ({
      unitId: unit.unitId,
      sectionId: unit.sectionId,
      relativePath: unit.relativePath,
      headingPath: unit.headingPath,
      content: unit.content,
      classification: unit.classification,
      assertions: unit.assertions,
      rationale: unit.rationale,
    })),
    assertions: classified.flatMap((unit) =>
      unit.assertions.map((assertion) => ({
        ...assertion,
        unitId: unit.unitId,
        artifactContext: unit.content,
        sectionId: unit.sectionId,
        relativePath: unit.relativePath,
        headingPath: unit.headingPath,
      })),
    ),
  };
}

/**
 * Assign stable identifiers, drop exact duplicates, and assemble the inventory
 * alongside the distinct assertions that proceed to accounting.
 */
function buildInventory(
  checkpointId: string,
  sectionCount: number,
  units: PrecisionTextUnitInventoryEntry[],
  extracted: RawExtractedAssertion[],
): {
  inventory: PrecisionAssertionInventory;
  assertions: ExtractedArtifactAssertion[];
} {
  const candidates: PrecisionAssertionInventoryEntry[] = [];
  const assertions: ExtractedArtifactAssertion[] = [];
  const firstByKey = new Map<string, string>();

  for (const [index, raw] of extracted.entries()) {
    const candidateId = `candidate-${String(index + 1).padStart(6, "0")}`;
    const key = deduplicationKey(raw.statement);
    const duplicateOf = firstByKey.get(key);
    const base = {
      candidateId,
      statement: raw.statement,
      sourceQuote: raw.sourceQuote,
      tense: raw.tense,
      sectionId: raw.sectionId,
      relativePath: raw.relativePath,
      headingPath: raw.headingPath,
    };
    if (duplicateOf !== undefined) {
      candidates.push({
        ...base,
        disposition: "excluded",
        exclusionReason: "exact-duplicate",
        duplicateOf,
      });
      continue;
    }

    const assertionId = `assertion-${String(assertions.length + 1).padStart(6, "0")}`;
    firstByKey.set(key, assertionId);
    assertions.push({
      id: assertionId,
      statement: raw.statement,
      sourceQuote: raw.sourceQuote,
      unitId: raw.unitId,
      artifactContext: raw.artifactContext,
      headingPath: raw.headingPath,
      tense: raw.tense,
      sectionId: raw.sectionId,
      relativePath: raw.relativePath,
    });
    candidates.push({ ...base, disposition: "kept", assertionId });
  }

  return {
    inventory: {
      checkpointId,
      totalSectionCount: sectionCount,
      extractedSectionCount: sectionCount,
      units,
      candidates,
      groundingEvidence: [],
      keptAssertionCount: assertions.length,
    },
    assertions,
  };
}

/**
 * Project an evidence corpus into searchable, checkpoint-annotated sections.
 */
function toEvidenceSections(corpus: EvidenceCorpus): EvidenceSection[] {
  return [...corpus.records]
    .sort((a, b) => compareStrings(a.evidenceId, b.evidenceId))
    .map((record) => ({
      id: record.evidenceId,
      ordinal: 0,
      relativePath: record.sourceRef,
      headingPath: [],
      content: record.content,
      searchableText: `${record.sourceRef}\n${record.content}`,
      observedAtCheckpoint: record.observedAtCheckpoint,
      current: record.current,
    }));
}

/** Keep one stable representative of byte-identical historical source. */
function deduplicateHistoricalEvidence(
  sections: EvidenceSection[],
): EvidenceSection[] {
  const distinct = new Map<string, EvidenceSection>();

  for (const section of [...sections].sort((a, b) =>
    compareStrings(a.id, b.id),
  )) {
    const comparableContent =
      section.relativePath === "git tracked files"
        ? section.content.slice(Math.max(0, section.content.indexOf("\n") + 1))
        : section.content;
    const key = `${section.relativePath}\0${comparableContent}`;
    if (!distinct.has(key)) {
      distinct.set(key, section);
    }
  }

  return [...distinct.values()];
}

/** Whether a claim explicitly names a source path represented by a section. */
function statementNamesSourcePath(
  statement: string,
  section: EvidenceSection,
): boolean {
  const sourceRef = section.relativePath.trim();
  return (
    sourceRef.length > 0 &&
    sourceRef !== "git tracked files" &&
    statement
      .toLocaleLowerCase("en-US")
      .includes(sourceRef.toLocaleLowerCase("en-US"))
  );
}

/** Extract filename-like source references without interpreting claim truth. */
function namedSourcePaths(statement: string): string[] {
  const matches =
    statement.match(
      /\/?(?:[\p{L}_@][\p{L}\p{N}_.@+-]*\/)*[\p{L}_@][\p{L}\p{N}_.@+-]*\.[\p{L}\p{N}]+/gu,
    ) ?? [];
  return matches.map((match) => match.replace(/^\//u, ""));
}

/** Whether a claim names a file that the complete source manifest omits. */
function statementNamesMissingSourcePath(
  statement: string,
  sections: EvidenceSection[],
): boolean {
  const sourceRefs = new Set(
    sections.map((section) => section.relativePath.toLocaleLowerCase("en-US")),
  );
  return namedSourcePaths(statement).some(
    (sourcePath) => !sourceRefs.has(sourcePath.toLocaleLowerCase("en-US")),
  );
}

/** Structural evidence that must not depend on lexical term overlap. */
function isMandatoryEvidence(
  assertion: ExtractedArtifactAssertion,
  section: EvidenceSection,
  sections: EvidenceSection[],
): boolean {
  return (
    (section.relativePath === "git tracked files" &&
      statementNamesMissingSourcePath(assertion.statement, sections)) ||
    statementNamesSourcePath(assertion.statement, section)
  );
}

/** Approximate stable prompt footprint for one source excerpt. */
function evidenceSize(section: EvidenceSection): number {
  return section.relativePath.length + section.content.length;
}

/**
 * Select bounded evidence while guaranteeing manifests and explicitly named
 * paths. When the complete corpus fits the soft budget, retain it in full.
 */
function selectEvidence(
  assertion: ExtractedArtifactAssertion,
  sections: EvidenceSection[],
  index: SectionBm25Index,
  routed: ResolvedEvidenceMapMatch,
): EvidenceSection[] {
  if (sections.length === 0) {
    return [];
  }

  const ranked = index
    .search(assertion.statement, sections.length)
    .map((item) => item.section as EvidenceSection);
  const mandatory = sections
    .filter((section) => isMandatoryEvidence(assertion, section, sections))
    .sort((a, b) => compareStrings(a.id, b.id));
  const selected: EvidenceSection[] = [];
  const selectedIds = new Set<string>();
  let size = 0;

  const add = (section: EvidenceSection): void => {
    if (selectedIds.has(section.id)) {
      return;
    }
    selectedIds.add(section.id);
    selected.push(section);
    size += evidenceSize(section);
  };

  mandatory.forEach(add);
  routed.sections.forEach((section) => add(section as EvidenceSection));
  for (const section of ranked) {
    if (
      selected.length < MIN_EVIDENCE_SECTIONS ||
      size + evidenceSize(section) <= EVIDENCE_CHAR_BUDGET
    ) {
      add(section);
    }
  }

  return selected;
}

/** Merge evidence lists without allowing one excerpt to appear twice. */
function mergeEvidence(...groups: EvidenceSection[][]): EvidenceSection[] {
  const byId = new Map<string, EvidenceSection>();
  for (const section of groups.flat()) {
    byId.set(section.id, section);
  }
  return [...byId.values()];
}

/**
 * Compute the cross-checkpoint cache key for one grounding judgment. The key is
 * a stable hash of everything the verdict depends on: the normalized statement,
 * its tense, and the full content signature of the grounding evidence set
 * (every field surfaced to the judge, evidence sorted by id so retrieval order
 * never perturbs the key). Two checkpoints that ground an identical claim on
 * byte-identical evidence therefore share a key and reuse the verdict.
 *
 * @param assertion - The claim being grounded.
 * @param evidence - The claim's own top-K grounding evidence.
 *
 * @returns A hex SHA-256 digest used only as a Map key, not for security.
 */
function precisionVerdictCacheKey(
  assertion: ExtractedArtifactAssertion,
  evidence: EvidenceSection[],
): string {
  const evidenceSignature = [...evidence]
    .sort((a, b) => compareStrings(a.id, b.id))
    .map((section) => [
      section.id,
      section.relativePath,
      section.observedAtCheckpoint,
      section.current,
      section.content,
    ]);
  const payload = JSON.stringify([
    normalizeStatement(assertion.statement),
    assertion.sourceQuote,
    assertion.unitId,
    assertion.artifactContext,
    assertion.headingPath,
    assertion.tense,
    evidenceSignature,
  ]);
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Strip a fresh grounding verdict down to its cacheable payload, dropping the
 * checkpoint-specific statement and location that the key already pins.
 */
function toCachedVerdict(
  evaluation: PrecisionAssertionEvaluation,
): CachedPrecisionVerdict {
  return {
    verdict: evaluation.verdict,
    adjudicatedBy: evaluation.adjudicatedBy,
    evidenceIds: [...evaluation.evidenceIds],
    rationale: evaluation.rationale,
  };
}

/**
 * Rebuild a full evaluation from a cached verdict, stamping the current
 * checkpoint's statement, tense, and document location. The statement and tense
 * are identical to the cached claim by construction of the key; the location is
 * taken fresh because the same claim may surface from a different document.
 */
function projectCachedVerdict(
  cached: CachedPrecisionVerdict,
  assertion: ExtractedArtifactAssertion,
): PrecisionAssertionEvaluation {
  return {
    assertion: assertion.statement,
    sourceQuote: assertion.sourceQuote,
    location: assertion.relativePath,
    verdict: cached.verdict,
    tense: assertion.tense,
    adjudicatedBy: cached.adjudicatedBy,
    evidenceIds: [...cached.evidenceIds],
    rationale: cached.rationale,
  };
}

/**
 * Project judgment targets into the grounding prompt's assertion shape.
 */
function toJudgmentAssertions(
  targets: PrecisionJudgmentTarget[],
): PrecisionJudgmentAssertion[] {
  return targets.map((target) => ({
    assertionId: target.assertion.id,
    statement: target.assertion.statement,
    sourceQuote: target.assertion.sourceQuote,
    artifactContextId: target.assertion.unitId,
    tense: target.assertion.tense,
    evidenceIds: target.evidence.map((evidence) => evidence.id),
  }));
}

/**
 * Collect complete artifact units once per judgment batch. Assertions reference
 * these by id so multiple claims from one unit do not duplicate prompt text.
 */
function toJudgmentArtifactContexts(
  targets: PrecisionJudgmentTarget[],
): PrecisionArtifactContext[] {
  const byId = new Map<string, PrecisionArtifactContext>();
  for (const target of targets) {
    const assertion = target.assertion;
    const existing = byId.get(assertion.unitId);
    const context: PrecisionArtifactContext = {
      contextId: assertion.unitId,
      relativePath: assertion.relativePath,
      headingPath: assertion.headingPath,
      content: assertion.artifactContext,
    };
    if (
      existing !== undefined &&
      JSON.stringify(existing) !== JSON.stringify(context)
    ) {
      throw new EvaluationError(
        `Precision assertion context identity "${assertion.unitId}" has conflicting content.`,
      );
    }
    byId.set(assertion.unitId, context);
  }
  return [...byId.values()];
}

/**
 * Collect the distinct evidence excerpts cited across the judgment targets.
 */
function toJudgmentEvidence(
  targets: PrecisionJudgmentTarget[],
): PrecisionEvidenceExcerpt[] {
  const byId = new Map<string, PrecisionEvidenceExcerpt>();
  for (const target of targets) {
    for (const section of target.evidence) {
      byId.set(section.id, {
        evidenceId: section.id,
        sourceRef: section.relativePath,
        observedAtCheckpoint: section.observedAtCheckpoint,
        current: section.current,
        content: section.content,
      });
    }
  }
  return [...byId.values()];
}

/**
 * Resolve grounding output into one verdict per target: `supported` claims are
 * adjudicated by source, `contradicted` claims map to `stale` or `invented` by
 * their formerly-true flag, and `not-addressed` claims fall through to
 * `unverified`. Enforces the citation and current/historical evidence rules for
 * each verdict class.
 */
function resolveJudgments(
  targets: PrecisionJudgmentTarget[],
  output: PrecisionJudgmentOutput,
): PrecisionAssertionEvaluation[] {
  const requested = new Set(targets.map((target) => target.assertion.id));
  const byId = new Map<
    string,
    PrecisionJudgmentOutput["evaluations"][number]
  >();
  for (const evaluation of output.evaluations) {
    if (
      !requested.has(evaluation.assertionId) ||
      byId.has(evaluation.assertionId)
    ) {
      throw new EvaluationError(
        `Precision grounding classifier returned unknown or duplicate assertionId "${evaluation.assertionId}".`,
      );
    }
    byId.set(evaluation.assertionId, evaluation);
  }

  return targets.map((target) => {
    const evaluation = byId.get(target.assertion.id);
    if (evaluation === undefined) {
      throw new EvaluationError(
        `Precision grounding classifier returned no verdict for assertionId "${target.assertion.id}".`,
      );
    }
    const evidenceById = new Map(
      target.evidence.map((item) => [item.id, item]),
    );
    if (
      new Set(evaluation.evidenceIds).size !== evaluation.evidenceIds.length
    ) {
      throw new EvaluationError(
        `Precision grounding classifier returned duplicate evidence IDs for assertionId "${target.assertion.id}".`,
      );
    }
    for (const id of evaluation.evidenceIds) {
      if (!evidenceById.has(id)) {
        throw new EvaluationError(
          `Precision grounding classifier cited unavailable evidenceId "${id}" for assertionId "${target.assertion.id}".`,
        );
      }
    }

    if (evaluation.verdict === "not-addressed") {
      if (
        evaluation.evidenceIds.length > 0 ||
        evaluation.formerlyTrue !== undefined
      ) {
        throw new EvaluationError(
          `Precision grounding classifier attached evidence or formerlyTrue to not-addressed assertionId "${target.assertion.id}".`,
        );
      }
      return {
        assertion: target.assertion.statement,
        sourceQuote: target.assertion.sourceQuote,
        location: target.assertion.relativePath,
        verdict: "unverified",
        tense: target.assertion.tense,
        adjudicatedBy: "none",
        evidenceIds: [],
        rationale: evaluation.rationale,
      };
    }

    if (evaluation.evidenceIds.length === 0) {
      throw new EvaluationError(
        `Precision grounding classifier returned no evidence for ${evaluation.verdict} assertionId "${target.assertion.id}".`,
      );
    }

    if (evaluation.verdict === "supported") {
      if (evaluation.formerlyTrue !== undefined) {
        throw new EvaluationError(
          `Precision grounding classifier returned formerlyTrue for supported assertionId "${target.assertion.id}".`,
        );
      }
      return {
        assertion: target.assertion.statement,
        sourceQuote: target.assertion.sourceQuote,
        location: target.assertion.relativePath,
        verdict: "supported",
        tense: target.assertion.tense,
        adjudicatedBy: "source",
        evidenceIds: evaluation.evidenceIds,
        rationale: evaluation.rationale,
      };
    }

    if (evaluation.formerlyTrue === undefined) {
      throw new EvaluationError(
        `Precision grounding classifier omitted formerlyTrue for contradicted assertionId "${target.assertion.id}".`,
      );
    }
    const cited = evaluation.evidenceIds.map(
      (id) => evidenceById.get(id) as EvidenceSection,
    );
    if (!cited.some((item) => item.current)) {
      throw new EvaluationError(
        `Precision contradiction lacks current evidence for assertionId "${target.assertion.id}".`,
      );
    }
    if (evaluation.formerlyTrue && !cited.some((item) => !item.current)) {
      throw new EvaluationError(
        `Precision formerlyTrue lacks historical evidence for assertionId "${target.assertion.id}".`,
      );
    }
    return {
      assertion: target.assertion.statement,
      sourceQuote: target.assertion.sourceQuote,
      location: target.assertion.relativePath,
      verdict: evaluation.formerlyTrue ? "stale" : "invented",
      tense: target.assertion.tense,
      adjudicatedBy: "source",
      evidenceIds: evaluation.evidenceIds,
      rationale: evaluation.rationale,
    };
  });
}

async function repairPrecisionJudgment(
  input: PrecisionPassInput,
  target: PrecisionJudgmentTarget,
  systemPrompt: string,
): Promise<PrecisionAssertionEvaluation> {
  const output = await invokeStructuredModel({
    model: input.model,
    pass: "precision-judgment",
    checkpointId: input.checkpointId,
    systemPrompt,
    taskPrompt: precisionJudgmentPrompt(
      toJudgmentAssertions([target]),
      toJudgmentEvidence([target]),
      toJudgmentArtifactContexts([target]),
    ),
    schema: precisionJudgmentOutputSchema,
    validate: (parsed) => resolveJudgments([target], parsed),
    timeoutMs: input.timeoutMs,
  });
  return resolveJudgments([target], output)[0];
}

/**
 * Resolve a batch while preserving valid neighbors and warning on failures.
 * Returns the verdicts in target order alongside the set of assertion ids whose
 * grounding could not be repaired and fell back to a warned `unverified`
 * verdict; the caller must never cache a degraded id, since its verdict reflects
 * an evaluator failure rather than a grounding decision.
 */
async function resolvePrecisionBatchResilient(
  input: PrecisionPassInput,
  targets: PrecisionJudgmentTarget[],
  systemPrompt = PRECISION_JUDGMENT_SYSTEM,
): Promise<{
  evaluations: PrecisionAssertionEvaluation[];
  degraded: Set<string>;
}> {
  let output: PrecisionJudgmentOutput;
  try {
    output = await invokeStructuredModel({
      model: input.model,
      pass: "precision-judgment",
      checkpointId: input.checkpointId,
      systemPrompt,
      taskPrompt: precisionJudgmentPrompt(
        toJudgmentAssertions(targets),
        toJudgmentEvidence(targets),
        toJudgmentArtifactContexts(targets),
      ),
      schema: precisionJudgmentBatchOutputSchema,
      timeoutMs: input.timeoutMs,
    });
  } catch (error) {
    const message = `Evaluator could not complete grounding batch: ${String(error)}`;
    const degraded = new Set(targets.map((target) => target.assertion.id));
    for (const target of targets) {
      input.onWarning?.({
        pass: "precision-judgment",
        itemId: target.assertion.id,
        message,
      });
    }
    return {
      evaluations: targets.map((target) => ({
        assertion: target.assertion.statement,
        sourceQuote: target.assertion.sourceQuote,
        location: target.assertion.relativePath,
        verdict: "unverified",
        tense: target.assertion.tense,
        adjudicatedBy: "none",
        evidenceIds: [],
        rationale: message,
      })),
      degraded,
    };
  }
  const results: PrecisionAssertionEvaluation[] = [];
  const degraded = new Set<string>();
  for (const target of targets) {
    try {
      const matching = output.evaluations.filter(
        (item) => item.assertionId === target.assertion.id,
      );
      results.push(...resolveJudgments([target], { evaluations: matching }));
    } catch (initialError) {
      try {
        results.push(
          await repairPrecisionJudgment(input, target, systemPrompt),
        );
      } catch (repairError) {
        const message = `${String(initialError)} Isolated repair failed: ${String(repairError)}`;
        input.onWarning?.({
          pass: "precision-judgment",
          itemId: target.assertion.id,
          message,
        });
        degraded.add(target.assertion.id);
        results.push({
          assertion: target.assertion.statement,
          sourceQuote: target.assertion.sourceQuote,
          location: target.assertion.relativePath,
          verdict: "unverified",
          tense: target.assertion.tense,
          adjudicatedBy: "none",
          evidenceIds: [],
          rationale: `Evaluator could not repair grounding judgment: ${message}`,
        });
      }
    }
  }
  return { evaluations: results, degraded };
}

/**
 * Extract atomic wiki claims and ground every one against the source evidence.
 *
 * There is no census-accounting stage: each extracted assertion (current or
 * historical) is judged against bounded source evidence. Current claims see
 * current source first; only a contradiction triggers a historical former-truth
 * check that separates stale from invented. Not-addressed claims are unverified.
 */
export async function runPrecisionPass(
  input: PrecisionPassInput,
): Promise<PrecisionAssertionEvaluation[]> {
  const extractionBatchSize =
    input.extractionBatchSize ?? DEFAULT_EXTRACTION_BATCH_SIZE;
  const judgmentBatchSize =
    input.judgmentBatchSize ?? DEFAULT_JUDGMENT_BATCH_SIZE;
  assertPositiveInteger(extractionBatchSize, "Precision extractionBatchSize");
  assertPositiveInteger(judgmentBatchSize, "Precision judgmentBatchSize");

  const limit = input.limit ?? createLimiter(DEFAULT_PASS_CONCURRENCY);
  const sections = [...input.sections].sort((a, b) =>
    compareStrings(a.id, b.id),
  );
  if (new Set(sections.map((section) => section.id)).size !== sections.length) {
    throw new EvaluationError(
      "Precision input contains duplicate artifact section IDs.",
    );
  }
  const extraction = await extractAssertions(
    input,
    sections,
    extractionBatchSize,
    limit,
  );
  const { inventory, assertions } = buildInventory(
    input.checkpointId,
    sections.length,
    extraction.units,
    extraction.assertions,
  );
  if (assertions.length === 0) {
    await input.onInventory?.(inventory);
    input.onGroundingProgress?.(0, 0);
    return [];
  }

  const evaluations = new Map<string, PrecisionAssertionEvaluation>();
  const evidenceSections = toEvidenceSections(input.evidence);

  // With no source evidence at all, grounding is a no-op: every claim is
  // unverified without a model call, and nothing is cached because the verdict
  // reflects an empty corpus rather than a grounding decision.
  if (evidenceSections.length === 0) {
    inventory.groundingEvidence = assertions.map((assertion) => ({
      assertionId: assertion.id,
      currentEvidenceIds: [],
      historicalEvidenceIds: [],
      evidenceMapEntryIds: [],
      evidenceMapSelectors: [],
      currentEvidenceMapSourceRefs: [],
      historicalEvidenceMapSourceRefs: [],
      historicalConsulted: false,
      cacheHit: false,
    }));
    await input.onInventory?.(inventory);
    const unverified = assertions.map(
      (assertion): PrecisionAssertionEvaluation => ({
        assertion: assertion.statement,
        sourceQuote: assertion.sourceQuote,
        location: assertion.relativePath,
        verdict: "unverified",
        tense: assertion.tense,
        adjudicatedBy: "none",
        evidenceIds: [],
        rationale: "No source evidence was available for grounding.",
      }),
    );
    input.onGroundingProgress?.(assertions.length, assertions.length);
    return unverified;
  }

  const currentEvidence = evidenceSections.filter((section) => section.current);
  const historicalEvidence = deduplicateHistoricalEvidence(
    evidenceSections.filter((section) => !section.current),
  );
  const currentEvidenceIndex = new SectionBm25Index(currentEvidence);
  const historicalEvidenceIndex = new SectionBm25Index(historicalEvidence);
  const evidenceRouter = new SemanticEvidenceRouter(input.evidenceMap);
  const cache = input.verdictCache;
  const selectedEvidence = new Map<
    string,
    { current: EvidenceSection[]; historical: EvidenceSection[] }
  >();
  const groundingInventory = new Map<
    string,
    PrecisionGroundingEvidenceInventoryEntry
  >();

  for (const assertion of assertions) {
    const route: EvidenceMapMatch = evidenceRouter.match(assertion.statement);
    const currentRoute = evidenceRouter.resolve(route, currentEvidence);
    const historicalRoute = evidenceRouter.resolve(route, historicalEvidence);
    const current = selectEvidence(
      assertion,
      currentEvidence,
      currentEvidenceIndex,
      currentRoute,
    );
    const historical = selectEvidence(
      assertion,
      historicalEvidence,
      historicalEvidenceIndex,
      historicalRoute,
    );
    selectedEvidence.set(assertion.id, { current, historical });
    groundingInventory.set(assertion.id, {
      assertionId: assertion.id,
      currentEvidenceIds: current.map((section) => section.id),
      historicalEvidenceIds: historical.map((section) => section.id),
      evidenceMapEntryIds: route.entryIds,
      evidenceMapSelectors: route.selectors,
      currentEvidenceMapSourceRefs: currentRoute.sourceRefs,
      historicalEvidenceMapSourceRefs: historicalRoute.sourceRefs,
      historicalConsulted:
        assertion.tense === "historical" && historical.length > 0,
      cacheHit: false,
    });
  }
  inventory.groundingEvidence = assertions.map((assertion) =>
    groundingInventory.get(assertion.id)!,
  );

  // Persist deterministic evidence selection before any grounding call. A
  // second write after judgment records which historical candidates were
  // actually consulted and which verdicts came from cache.
  await input.onInventory?.(inventory);

  const cacheKeyById = new Map<string, string>();
  const currentTargets: PrecisionJudgmentTarget[] = [];
  const historicalClaimTargets: PrecisionJudgmentTarget[] = [];

  for (const assertion of assertions) {
    const selected = selectedEvidence.get(assertion.id)!;
    const cacheKey = precisionVerdictCacheKey(
      assertion,
      mergeEvidence(selected.current, selected.historical),
    );
    cacheKeyById.set(assertion.id, cacheKey);
    const cached = cache?.get(cacheKey);
    if (cached !== undefined) {
      evaluations.set(assertion.id, projectCachedVerdict(cached, assertion));
      groundingInventory.get(assertion.id)!.cacheHit = true;
      continue;
    }

    const evidence =
      assertion.tense === "current"
        ? selected.current
        : mergeEvidence(selected.current, selected.historical);
    if (evidence.length === 0) {
      evaluations.set(assertion.id, {
        assertion: assertion.statement,
        sourceQuote: assertion.sourceQuote,
        location: assertion.relativePath,
        verdict: "unverified",
        tense: assertion.tense,
        adjudicatedBy: "none",
        evidenceIds: [],
        rationale:
          assertion.tense === "current"
            ? "No current source evidence was available for grounding."
            : "No current or historical source evidence was available for grounding.",
      });
      continue;
    }

    const target = { assertion, evidence };
    if (assertion.tense === "current") {
      currentTargets.push(target);
    } else {
      historicalClaimTargets.push(target);
    }
  }
  input.onGroundingProgress?.(evaluations.size, assertions.length);

  /** Judge targets in bounded batches while retaining target identity. */
  const judgeTargets = async (
    targets: PrecisionJudgmentTarget[],
    systemPrompt: string,
  ): Promise<
    Array<{
      target: PrecisionJudgmentTarget;
      evaluation: PrecisionAssertionEvaluation;
      degraded: boolean;
    }>
  > => {
    const judgedBatches = await mapWithLimit(
      batch(targets, judgmentBatchSize),
      limit,
      async (targetBatch) => {
        const resolved = await resolvePrecisionBatchResilient(
          input,
          targetBatch,
          systemPrompt,
        );
        return resolved.evaluations.map((evaluation, index) => ({
          target: targetBatch[index],
          evaluation,
          degraded: resolved.degraded.has(targetBatch[index].assertion.id),
        }));
      },
    );
    return judgedBatches.flat();
  };

  // Current claims see only current source. Historical narration may require
  // both sides of a transition, so it retains the combined bounded corpus.
  const [currentJudgments, historicalClaimJudgments] = await Promise.all([
    judgeTargets(currentTargets, PRECISION_JUDGMENT_SYSTEM),
    judgeTargets(historicalClaimTargets, PRECISION_JUDGMENT_SYSTEM),
  ]);
  const pendingFormerTruth: Array<{
    target: PrecisionJudgmentTarget;
    currentEvaluation: PrecisionAssertionEvaluation;
  }> = [];

  for (const { target, evaluation, degraded } of historicalClaimJudgments) {
    const id = target.assertion.id;
    evaluations.set(id, evaluation);
    const cacheKey = cacheKeyById.get(id);
    if (cache !== undefined && cacheKey !== undefined && !degraded) {
      cache.set(cacheKey, toCachedVerdict(evaluation));
    }
  }

  for (const { target, evaluation, degraded } of currentJudgments) {
    const id = target.assertion.id;
    if (!degraded && evaluation.verdict === "invented") {
      pendingFormerTruth.push({ target, currentEvaluation: evaluation });
      continue;
    }

    evaluations.set(id, evaluation);
    const cacheKey = cacheKeyById.get(id);
    if (cache !== undefined && cacheKey !== undefined && !degraded) {
      cache.set(cacheKey, toCachedVerdict(evaluation));
    }
  }
  input.onGroundingProgress?.(evaluations.size, assertions.length);

  const historicalTargets: PrecisionJudgmentTarget[] = [];
  const pendingById = new Map(
    pendingFormerTruth.map((pending) => [pending.target.assertion.id, pending]),
  );
  for (const pending of pendingFormerTruth) {
    const id = pending.target.assertion.id;
    const historical = selectedEvidence.get(id)!.historical;
    if (historical.length === 0) {
      evaluations.set(id, pending.currentEvaluation);
      const cacheKey = cacheKeyById.get(id);
      if (cache !== undefined && cacheKey !== undefined) {
        cache.set(cacheKey, toCachedVerdict(pending.currentEvaluation));
      }
      continue;
    }

    groundingInventory.get(id)!.historicalConsulted = true;
    historicalTargets.push({
      assertion: { ...pending.target.assertion, tense: "historical" },
      evidence: historical,
    });
  }
  input.onGroundingProgress?.(evaluations.size, assertions.length);

  const formerTruthJudgments = await judgeTargets(
    historicalTargets,
    PRECISION_HISTORY_JUDGMENT_SYSTEM,
  );
  for (const { target, evaluation, degraded } of formerTruthJudgments) {
    const id = target.assertion.id;
    const pending = pendingById.get(id)!;
    let finalEvaluation: PrecisionAssertionEvaluation;

    if (degraded) {
      finalEvaluation = {
        ...evaluation,
        assertion: pending.target.assertion.statement,
        location: pending.target.assertion.relativePath,
        tense: "current",
        rationale: `Current source established a contradiction, but former truth could not be determined. ${evaluation.rationale}`,
      };
    } else if (evaluation.verdict === "supported") {
      finalEvaluation = {
        assertion: pending.target.assertion.statement,
        sourceQuote: pending.target.assertion.sourceQuote,
        location: pending.target.assertion.relativePath,
        verdict: "stale",
        tense: "current",
        adjudicatedBy: "source",
        evidenceIds: [
          ...pending.currentEvaluation.evidenceIds,
          ...evaluation.evidenceIds,
        ],
        rationale: `${pending.currentEvaluation.rationale} Historical evidence establishes that the claim was formerly true: ${evaluation.rationale}`,
      };
    } else {
      finalEvaluation = {
        ...pending.currentEvaluation,
        rationale: `${pending.currentEvaluation.rationale} Historical evidence did not establish that the claim was formerly true: ${evaluation.rationale}`,
      };
    }

    evaluations.set(id, finalEvaluation);
    const cacheKey = cacheKeyById.get(id);
    if (cache !== undefined && cacheKey !== undefined && !degraded) {
      cache.set(cacheKey, toCachedVerdict(finalEvaluation));
    }
  }
  input.onGroundingProgress?.(evaluations.size, assertions.length);

  // Finalize the audit inventory after cache resolution and any historical
  // follow-up. The durable sink overwrites the pre-judgment snapshot in place.
  await input.onInventory?.(inventory);

  return assertions.map(
    (assertion) =>
      evaluations.get(assertion.id) as PrecisionAssertionEvaluation,
  );
}
