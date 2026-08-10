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
import { assertPositiveInteger, batch } from "./pass-utils.js";
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
 */
const DEFAULT_EXTRACTION_BATCH_SIZE = 10;

/**
 * Default number of assertions grounded per judgment request.
 */
const DEFAULT_JUDGMENT_BATCH_SIZE = 10;

/**
 * Default number of evidence sections retrieved per bounded grounding judgment.
 */
const DEFAULT_EVIDENCE_TOP_K = 8;

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
   * @default 10
   */
  extractionBatchSize?: number;

  /**
   * Number of assertions grounded per judgment request.
   *
   * @default 10
   */
  judgmentBatchSize?: number;

  /**
   * Per-attempt evaluator request deadline in milliseconds.
   *
   * @default undefined no per-attempt deadline is applied
   */
  timeoutMs?: number;

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
 * Classify every section's text units and flatten the extracted claims. Each
 * requested unit is resolved individually from the batch response, so a single
 * dropped or malformed unit is repaired in isolation and, only if that also
 * fails, degraded to a warned no-claim unit rather than crashing the pass.
 */
async function extractAssertions(
  input: PrecisionPassInput,
  sections: ArtifactSection[],
  batchSize: number,
): Promise<{
  units: PrecisionTextUnitInventoryEntry[];
  assertions: RawExtractedAssertion[];
}> {
  const units = sections.flatMap(textUnitsForSection);
  const classified: ClassifiedPrecisionTextUnit[] = [];

  for (const unitBatch of batch(units, batchSize)) {
    const output = await invokeStructuredModel({
      model: input.model,
      pass: "precision-extraction",
      checkpointId: input.checkpointId,
      systemPrompt: PRECISION_EXTRACTION_SYSTEM,
      taskPrompt: precisionExtractionPrompt(unitBatch),
      schema: assertionExtractionOutputSchema,
      timeoutMs: input.timeoutMs,
    });
    for (const unit of unitBatch) {
      try {
        classified.push(resolveExtractionUnit(unit, output));
      } catch (initialError) {
        try {
          classified.push(await repairExtractionUnit(input, unit));
        } catch (repairError) {
          const message = `${String(initialError)} Isolated repair failed: ${String(repairError)}`;
          input.onWarning?.({
            pass: "precision-extraction",
            itemId: unit.unitId,
            message,
          });
          classified.push(degradedExtractionUnit(unit, message));
        }
      }
    }
  }

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
 * Give each target the stable union actually visible in its shared batch.
 */
function shareBatchEvidence(
  targets: PrecisionJudgmentTarget[],
): PrecisionJudgmentTarget[] {
  const byId = new Map<string, EvidenceSection>();
  for (const target of targets) {
    for (const evidence of target.evidence) byId.set(evidence.id, evidence);
  }
  const shared = [...byId.values()].sort((a, b) => compareStrings(a.id, b.id));
  return targets.map((target) => ({ ...target, evidence: shared }));
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
 */
async function resolvePrecisionBatchResilient(
  input: PrecisionPassInput,
  targets: PrecisionJudgmentTarget[],
): Promise<PrecisionAssertionEvaluation[]> {
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
  return results;
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
  const evidenceIndex = new SectionBm25Index(evidenceSections);

  for (const assertionBatch of batch(assertions, judgmentBatchSize)) {
    if (evidenceSections.length === 0) {
      for (const assertion of assertionBatch) {
        evaluations.set(assertion.id, {
          assertion: assertion.statement,
          location: assertion.relativePath,
          verdict: "unverified",
          tense: assertion.tense,
          adjudicatedBy: "none",
          evidenceIds: [],
          rationale: "No source evidence was available for grounding.",
        });
      }
      continue;
    }
    const targets = shareBatchEvidence(
      assertionBatch.map((assertion) => ({
        assertion,
        evidence: evidenceIndex
          .search(assertion.statement, DEFAULT_EVIDENCE_TOP_K)
          .map((ranked) => ranked.section as EvidenceSection),
      })),
    );
    const judged = await resolvePrecisionBatchResilient(input, targets);
    for (const [index, evaluation] of judged.entries()) {
      evaluations.set(targets[index].assertion.id, evaluation);
    }
  }

  return assertions.map(
    (assertion) =>
      evaluations.get(assertion.id) as PrecisionAssertionEvaluation,
  );
}
