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
  PRECISION_JUDGMENT_SYSTEM,
  precisionExtractionPrompt,
  precisionJudgmentPrompt,
  type PrecisionEvidenceExcerpt,
  type PrecisionExtractionUnit,
  type PrecisionJudgmentAssertion,
} from "./prompts.js";
import { SectionBm25Index } from "./retrieval.js";
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

/**
 * Default number of evidence sections retrieved per bounded grounding judgment.
 */
const DEFAULT_EVIDENCE_TOP_K = 8;

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
  assertions: Array<{ statement: string; tense: PrecisionClaimTense }>;

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

  /**
   * Number of distinct assertions kept for accounting.
   */
  keptAssertionCount: number;
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
   * Source evidence corpus every claim is grounded against. It folds prior
   * checkpoints' source as historical (`current: false`) records, so staleness
   * is emergent: a claim the current source contradicts but earlier source
   * supported is stale, otherwise invented.
   */
  evidence: EvidenceCorpus;

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
  assertions: Array<{ statement: string; tense: PrecisionClaimTense }>;

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

  return blocks.map((content, index) => ({
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
  }
  return {
    ...unit,
    classification: result.classification,
    assertions: result.assertions.map((assertion) => ({
      statement: normalizeStatement(assertion.statement),
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
  const batchResults = await mapWithLimit(
    batch(units, batchSize),
    limit,
    (unitBatch) => classifyUnitBatch(input, unitBatch),
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
    tense: target.assertion.tense,
    evidenceIds: target.evidence.map((evidence) => evidence.id),
  }));
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
): Promise<PrecisionAssertionEvaluation> {
  const output = await invokeStructuredModel({
    model: input.model,
    pass: "precision-judgment",
    checkpointId: input.checkpointId,
    systemPrompt: PRECISION_JUDGMENT_SYSTEM,
    taskPrompt: precisionJudgmentPrompt(
      toJudgmentAssertions([target]),
      toJudgmentEvidence([target]),
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
): Promise<{
  evaluations: PrecisionAssertionEvaluation[];
  degraded: Set<string>;
}> {
  const output = await invokeStructuredModel({
    model: input.model,
    pass: "precision-judgment",
    checkpointId: input.checkpointId,
    systemPrompt: PRECISION_JUDGMENT_SYSTEM,
    taskPrompt: precisionJudgmentPrompt(
      toJudgmentAssertions(targets),
      toJudgmentEvidence(targets),
    ),
    schema: precisionJudgmentBatchOutputSchema,
    timeoutMs: input.timeoutMs,
  });
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
        results.push(await repairPrecisionJudgment(input, target));
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
 * historical) is judged directly against the retrieved source evidence, which
 * `supported`, `contradicted` (stale or invented), or `not-addressed`
 * (`unverified`).
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
  await input.onInventory?.(inventory);
  if (assertions.length === 0) return [];

  const evaluations = new Map<string, PrecisionAssertionEvaluation>();
  const evidenceSections = toEvidenceSections(input.evidence);

  // With no source evidence at all, grounding is a no-op: every claim is
  // unverified without a model call, and nothing is cached because the verdict
  // reflects an empty corpus rather than a grounding decision.
  if (evidenceSections.length === 0) {
    return assertions.map((assertion): PrecisionAssertionEvaluation => ({
      assertion: assertion.statement,
      location: assertion.relativePath,
      verdict: "unverified",
      tense: assertion.tense,
      adjudicatedBy: "none",
      evidenceIds: [],
      rationale: "No source evidence was available for grounding.",
    }));
  }

  const evidenceIndex = new SectionBm25Index(evidenceSections);
  const cache = input.verdictCache;

  // Ground each assertion on its OWN deterministic BM25 top-K rather than the
  // batch union, so a verdict is a pure function of (statement, tense, own
  // evidence) and can be reused across checkpoints. Cache hits are resolved up
  // front with no model call; only the misses are batched and judged. The
  // grounding prompt still shows a batch's evidence as one deduped excerpt list,
  // but each assertion may cite only its own top-K, which the resolver enforces.
  const uncached: Array<{
    target: PrecisionJudgmentTarget;
    cacheKey: string;
  }> = [];
  for (const assertion of assertions) {
    const evidence = evidenceIndex
      .search(assertion.statement, DEFAULT_EVIDENCE_TOP_K)
      .map((ranked) => ranked.section as EvidenceSection);
    const cacheKey = precisionVerdictCacheKey(assertion, evidence);
    const cached = cache?.get(cacheKey);
    if (cached !== undefined) {
      evaluations.set(assertion.id, projectCachedVerdict(cached, assertion));
    } else {
      uncached.push({ target: { assertion, evidence }, cacheKey });
    }
  }
  const cacheKeyById = new Map(
    uncached.map(({ target, cacheKey }) => [target.assertion.id, cacheKey]),
  );

  // Judgment batches are independent: each writes only its own assertions'
  // verdicts (assertion ids are unique across batches), so they run concurrently
  // under the shared limiter. Only non-degraded verdicts are cached; a repair
  // fallback reflects an evaluator failure, not a grounding decision.
  await mapWithLimit(
    batch(
      uncached.map(({ target }) => target),
      judgmentBatchSize,
    ),
    limit,
    async (targetBatch) => {
      const { evaluations: judged, degraded } =
        await resolvePrecisionBatchResilient(input, targetBatch);
      for (const [index, evaluation] of judged.entries()) {
        const { id } = targetBatch[index].assertion;
        evaluations.set(id, evaluation);
        const cacheKey = cacheKeyById.get(id);
        if (
          cache !== undefined &&
          cacheKey !== undefined &&
          !degraded.has(id)
        ) {
          cache.set(cacheKey, toCachedVerdict(evaluation));
        }
      }
    },
  );

  return assertions.map(
    (assertion) =>
      evaluations.get(assertion.id) as PrecisionAssertionEvaluation,
  );
}
