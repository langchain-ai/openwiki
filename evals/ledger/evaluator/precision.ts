import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { EvaluationError } from "../core/errors.js";
import { compareStrings } from "../core/order.js";
import type {
  ActiveTruthFact,
  CheckpointTransitions,
  EvidenceCorpus,
  EvaluationWarning,
  ObsoleteFactTarget,
  PrecisionAssertionEvaluation,
  PrecisionClaimTense,
} from "../core/types.js";
import { invokeStructuredModel } from "./direct-model.js";
import type { ArtifactSection } from "./documents.js";
import { assertPositiveInteger, batch } from "./pass-utils.js";
import {
  PRECISION_EXTRACTION_SYSTEM,
  PRECISION_JUDGMENT_SYSTEM,
  PRECISION_LEDGER_SYSTEM,
  precisionExtractionPrompt,
  precisionJudgmentPrompt,
  precisionLedgerPrompt,
  type PrecisionEvidenceExcerpt,
  type PrecisionExtractionUnit,
  type PrecisionJudgmentAssertion,
  type PrecisionLedgerFact,
} from "./prompts.js";
import { SectionBm25Index } from "./retrieval.js";
import {
  assertionExtractionOutputSchema,
  precisionJudgmentOutputSchema,
  precisionLedgerOutputSchema,
  type AssertionExtractionOutput,
  type PrecisionJudgmentOutput,
  type PrecisionLedgerOutput,
} from "./schemas.js";

/**
 * Default number of text units classified per extraction request.
 */
const DEFAULT_EXTRACTION_BATCH_SIZE = 10;

/**
 * Default number of assertions accounted per ledger/judgment request.
 */
const DEFAULT_JUDGMENT_BATCH_SIZE = 10;

/**
 * Default number of evidence sections retrieved per bounded refutation.
 */
const DEFAULT_EVIDENCE_TOP_K = 8;

/**
 * One extracted artifact claim carried through ledger and refutation passes.
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
   * Evaluator model used for extraction, accounting, and refutation.
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
   * Truth-ledger facts current at the checkpoint.
   */
  activeFacts: ActiveTruthFact[];

  /**
   * Truth-ledger facts that were superseded before the checkpoint.
   *
   * @default [] no superseded facts are considered
   */
  supersededFacts?: ObsoleteFactTarget[];

  /**
   * Fact transitions crossing into this checkpoint, used as accounting context.
   *
   * @default undefined at the first checkpoint, where no transitions exist
   */
  transitions?: CheckpointTransitions;

  /**
   * Source evidence corpus used for bounded refutation.
   */
  evidence: EvidenceCorpus;

  /**
   * Number of text units classified per extraction request.
   *
   * @default 10
   */
  extractionBatchSize?: number;

  /**
   * Number of assertions accounted per ledger/judgment request.
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
 * One assertion's verdict from the truth-ledger accounting pass.
 */
interface LedgerAssertionEvaluation {
  /**
   * Assertion the verdict applies to.
   */
  assertionId: string;

  /**
   * Whether the claim is supported, contradicted, or unaccounted by the ledger.
   */
  verdict: "supported" | "contradicted" | "unaccounted";

  /**
   * Fact versions cited in support of the verdict.
   */
  factVersionIds: string[];

  /**
   * Whether a contradicted claim was formerly true (stale) rather than invented.
   *
   * @default undefined for non-contradicted verdicts
   */
  formerlyTrue?: boolean;

  /**
   * Accounting rationale.
   */
  rationale: string;

  /**
   * Whether the evaluator failed and the verdict is a resilient fallback.
   *
   * @default undefined when accounting succeeded
   */
  evaluatorFailed?: boolean;
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
 * One assertion paired with the evidence visible to its refutation.
 */
interface PrecisionJudgmentTarget {
  /**
   * Assertion being refuted.
   */
  assertion: ExtractedArtifactAssertion;

  /**
   * Candidate evidence sections for the refutation.
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
 * Resolve raw extraction output into one classified unit per requested unit,
 * rejecting unknown, duplicate, or classification-inconsistent responses.
 */
function resolveExtraction(
  units: PrecisionTextUnit[],
  output: AssertionExtractionOutput,
): ClassifiedPrecisionTextUnit[] {
  const requested = new Set(units.map((unit) => unit.unitId));
  const byId = new Map<string, AssertionExtractionOutput["units"][number]>();

  for (const result of output.units) {
    if (!requested.has(result.unitId) || byId.has(result.unitId)) {
      throw new EvaluationError(
        `Precision extractor returned unknown or duplicate unitId "${result.unitId}".`,
      );
    }
    const yieldsClaims =
      result.classification === "factual" || result.classification === "mixed";
    if (yieldsClaims !== result.assertions.length > 0) {
      throw new EvaluationError(
        `Precision extractor returned classification "${result.classification}" with ${result.assertions.length} assertions for unitId "${result.unitId}".`,
      );
    }
    for (const assertion of result.assertions) {
      if (
        deduplicationKey(normalizeStatement(assertion.statement)).length === 0
      ) {
        throw new EvaluationError(
          `Precision extractor returned an empty assertion for unitId "${result.unitId}".`,
        );
      }
    }
    byId.set(result.unitId, result);
  }

  return units.map((unit) => {
    const result = byId.get(unit.unitId);
    if (result === undefined) {
      throw new EvaluationError(
        `Precision extractor returned no result for unitId "${unit.unitId}".`,
      );
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
  });
}

/**
 * Classify every section's text units and flatten the extracted claims.
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
      validate: (parsed) => resolveExtraction(unitBatch, parsed),
      timeoutMs: input.timeoutMs,
    });
    classified.push(...resolveExtraction(unitBatch, output));
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
 * Project active and superseded facts into the ledger-accounting shape.
 */
function toLedgerFacts(input: PrecisionPassInput): PrecisionLedgerFact[] {
  return [
    ...input.activeFacts.map((fact) => ({
      factId: fact.factId,
      factVersionId: fact.factVersionId,
      statement: fact.statement,
      current: true,
    })),
    ...(input.supersededFacts ?? []).map((fact) => ({
      factId: fact.factId,
      factVersionId: fact.factVersionId,
      statement: fact.obsoleteStatement,
      current: false,
    })),
  ];
}

/**
 * Extract and fully validate one assertion's ledger verdict, enforcing the
 * evidence and formerly-true invariants for each verdict class.
 */
function resolveLedgerItem(
  assertion: ExtractedArtifactAssertion,
  output: PrecisionLedgerOutput,
  facts: PrecisionLedgerFact[],
): LedgerAssertionEvaluation {
  const matches = output.evaluations.filter(
    (evaluation) => evaluation.assertionId === assertion.id,
  );
  if (matches.length !== 1) {
    throw new EvaluationError(
      `Precision ledger classifier returned ${matches.length} verdicts for assertionId "${assertion.id}".`,
    );
  }
  const [evaluation] = matches;
  const byId = new Map(facts.map((fact) => [fact.factVersionId, fact]));
  const uniqueIds = new Set(evaluation.factVersionIds);
  if (uniqueIds.size !== evaluation.factVersionIds.length) {
    throw new EvaluationError(
      `Precision ledger classifier returned duplicate factVersionIds for assertionId "${assertion.id}".`,
    );
  }
  for (const id of evaluation.factVersionIds) {
    if (!byId.has(id)) {
      throw new EvaluationError(
        `Precision ledger classifier cited unavailable factVersionId "${id}" for assertionId "${assertion.id}".`,
      );
    }
  }
  if (evaluation.verdict === "unaccounted") {
    if (
      evaluation.factVersionIds.length > 0 ||
      evaluation.formerlyTrue !== undefined
    ) {
      throw new EvaluationError(
        `Precision ledger classifier attached evidence or formerlyTrue to unaccounted assertionId "${assertion.id}".`,
      );
    }
  } else if (evaluation.factVersionIds.length === 0) {
    throw new EvaluationError(
      `Precision ledger classifier returned no factVersionIds for ${evaluation.verdict} assertionId "${assertion.id}".`,
    );
  }
  if (evaluation.verdict === "contradicted") {
    if (evaluation.formerlyTrue === undefined) {
      throw new EvaluationError(
        `Precision ledger classifier omitted formerlyTrue for contradicted assertionId "${assertion.id}".`,
      );
    }
    const cited = evaluation.factVersionIds.map(
      (id) => byId.get(id) as PrecisionLedgerFact,
    );
    if (!cited.some((fact) => fact.current)) {
      throw new EvaluationError(
        `Precision ledger contradiction lacks a current fact for assertionId "${assertion.id}".`,
      );
    }
    if (evaluation.formerlyTrue && !cited.some((fact) => !fact.current)) {
      throw new EvaluationError(
        `Precision ledger formerlyTrue lacks a superseded fact for assertionId "${assertion.id}".`,
      );
    }
  } else if (evaluation.formerlyTrue !== undefined) {
    throw new EvaluationError(
      `Precision ledger classifier returned formerlyTrue for ${evaluation.verdict} assertionId "${assertion.id}".`,
    );
  }
  return evaluation;
}

/**
 * Re-run ledger accounting for a single assertion in isolation.
 */
async function repairLedgerItem(
  input: PrecisionPassInput,
  assertion: ExtractedArtifactAssertion,
  facts: PrecisionLedgerFact[],
): Promise<LedgerAssertionEvaluation> {
  const output = await invokeStructuredModel({
    model: input.model,
    pass: "precision-ledger",
    checkpointId: input.checkpointId,
    systemPrompt: PRECISION_LEDGER_SYSTEM,
    taskPrompt: precisionLedgerPrompt(
      [
        {
          assertionId: assertion.id,
          statement: assertion.statement,
          tense: assertion.tense,
        },
      ],
      facts,
      input.transitions,
    ),
    schema: precisionLedgerOutputSchema,
    validate: (parsed) => resolveLedgerItem(assertion, parsed, facts),
    timeoutMs: input.timeoutMs,
  });
  return resolveLedgerItem(assertion, output, facts);
}

/**
 * Account every claim against current and superseded truth-ledger facts.
 */
async function runLedgerAccounting(
  input: PrecisionPassInput,
  assertions: ExtractedArtifactAssertion[],
): Promise<LedgerAssertionEvaluation[]> {
  const facts = toLedgerFacts(input);
  if (facts.length === 0) {
    return assertions.map((assertion) => ({
      assertionId: assertion.id,
      verdict: "unaccounted",
      factVersionIds: [],
      rationale: "No truth-ledger facts were supplied.",
    }));
  }

  const results: LedgerAssertionEvaluation[] = [];
  for (const assertionBatch of batch(
    assertions,
    input.judgmentBatchSize ?? DEFAULT_JUDGMENT_BATCH_SIZE,
  )) {
    const output = await invokeStructuredModel({
      model: input.model,
      pass: "precision-ledger",
      checkpointId: input.checkpointId,
      systemPrompt: PRECISION_LEDGER_SYSTEM,
      taskPrompt: precisionLedgerPrompt(
        assertionBatch.map((assertion) => ({
          assertionId: assertion.id,
          statement: assertion.statement,
          tense: assertion.tense,
        })),
        facts,
        input.transitions,
      ),
      schema: precisionLedgerOutputSchema,
      timeoutMs: input.timeoutMs,
    });

    for (const assertion of assertionBatch) {
      try {
        results.push(resolveLedgerItem(assertion, output, facts));
      } catch (initialError) {
        try {
          results.push(await repairLedgerItem(input, assertion, facts));
        } catch (repairError) {
          const message = `${String(initialError)} Isolated repair failed: ${String(repairError)}`;
          input.onWarning?.({
            pass: "precision-ledger",
            itemId: assertion.id,
            message,
          });
          results.push({
            assertionId: assertion.id,
            verdict: "unaccounted",
            factVersionIds: [],
            rationale: `Evaluator could not repair ledger accounting: ${message}`,
            evaluatorFailed: true,
          });
        }
      }
    }
  }
  return results;
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
 * Project judgment targets into the refutation prompt's assertion shape.
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
 * Resolve refutation output into one verdict per target, mapping refuted claims
 * to `stale` or `invented` and enforcing the current/historical evidence rules.
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
        `Precision refuter returned unknown or duplicate assertionId "${evaluation.assertionId}".`,
      );
    }
    byId.set(evaluation.assertionId, evaluation);
  }

  return targets.map((target) => {
    const evaluation = byId.get(target.assertion.id);
    if (evaluation === undefined) {
      throw new EvaluationError(
        `Precision refuter returned no verdict for assertionId "${target.assertion.id}".`,
      );
    }
    const evidenceById = new Map(
      target.evidence.map((item) => [item.id, item]),
    );
    if (
      new Set(evaluation.evidenceIds).size !== evaluation.evidenceIds.length
    ) {
      throw new EvaluationError(
        `Precision refuter returned duplicate evidence IDs for assertionId "${target.assertion.id}".`,
      );
    }
    for (const id of evaluation.evidenceIds) {
      if (!evidenceById.has(id)) {
        throw new EvaluationError(
          `Precision refuter cited unavailable evidenceId "${id}" for assertionId "${target.assertion.id}".`,
        );
      }
    }
    if (evaluation.verdict === "not-refuted") {
      if (
        evaluation.evidenceIds.length > 0 ||
        evaluation.formerlyTrue !== undefined
      ) {
        throw new EvaluationError(
          `Precision refuter attached evidence or formerlyTrue to not-refuted assertionId "${target.assertion.id}".`,
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
    if (evaluation.formerlyTrue === undefined) {
      throw new EvaluationError(
        `Precision refuter omitted formerlyTrue for contradicted assertionId "${target.assertion.id}".`,
      );
    }
    const cited = evaluation.evidenceIds.map(
      (id) => evidenceById.get(id) as EvidenceSection,
    );
    if (!cited.some((item) => item.current)) {
      throw new EvaluationError(
        `Precision refutation lacks current evidence for assertionId "${target.assertion.id}".`,
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
    schema: precisionJudgmentOutputSchema,
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
          rationale: `Evaluator could not repair refutation judgment: ${message}`,
        });
      }
    }
  }
  return results;
}

/**
 * Run extraction, truth-ledger accounting, and one bounded refutation pass.
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

  const ledgerResults = await runLedgerAccounting(input, assertions);
  const ledgerById = new Map(
    ledgerResults.map((result) => [result.assertionId, result]),
  );
  const evaluations = new Map<string, PrecisionAssertionEvaluation>();
  const needsRefutation: ExtractedArtifactAssertion[] = [];

  for (const assertion of assertions) {
    const result = ledgerById.get(assertion.id) as LedgerAssertionEvaluation;
    if (result.verdict === "supported") {
      evaluations.set(assertion.id, {
        assertion: assertion.statement,
        location: assertion.relativePath,
        verdict: "supported",
        tense: assertion.tense,
        adjudicatedBy: "ledger",
        evidenceIds: result.factVersionIds,
        rationale: result.rationale,
      });
    } else if (result.verdict === "contradicted") {
      evaluations.set(assertion.id, {
        assertion: assertion.statement,
        location: assertion.relativePath,
        verdict: result.formerlyTrue ? "stale" : "invented",
        tense: assertion.tense,
        adjudicatedBy: "ledger",
        evidenceIds: result.factVersionIds,
        rationale: result.rationale,
      });
    } else if (assertion.tense === "historical" || result.evaluatorFailed) {
      evaluations.set(assertion.id, {
        assertion: assertion.statement,
        location: assertion.relativePath,
        verdict: "unverified",
        tense: assertion.tense,
        adjudicatedBy: "none",
        evidenceIds: [],
        rationale: result.rationale,
      });
    } else {
      needsRefutation.push(assertion);
    }
  }

  const evidenceSections = toEvidenceSections(input.evidence);
  const evidenceIndex = new SectionBm25Index(evidenceSections);
  for (const assertionBatch of batch(needsRefutation, judgmentBatchSize)) {
    if (evidenceSections.length === 0) {
      for (const assertion of assertionBatch) {
        evaluations.set(assertion.id, {
          assertion: assertion.statement,
          location: assertion.relativePath,
          verdict: "unverified",
          tense: assertion.tense,
          adjudicatedBy: "none",
          evidenceIds: [],
          rationale: "No source evidence was available for bounded refutation.",
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
