import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { EvaluationError } from "../core/errors.js";
import type {
  ActiveTruthFact,
  PrecisionAssertionEvaluation,
} from "../core/types.js";
import { invokeStructuredModel } from "./direct-model.js";
import type { ArtifactSection } from "./documents.js";
import {
  PRECISION_EXTRACTION_SYSTEM,
  PRECISION_JUDGMENT_SYSTEM,
  precisionExtractionPrompt,
  precisionJudgmentPrompt,
  type PrecisionExtractionSection,
  type PrecisionJudgmentAssertion,
  type PrecisionJudgmentFact,
} from "./prompts.js";
import {
  assertionExtractionOutputSchema,
  precisionJudgmentOutputSchema,
  type AssertionExtractionOutput,
  type PrecisionJudgmentOutput,
} from "./schemas.js";

const DEFAULT_EXTRACTION_BATCH_SIZE = 4;
const DEFAULT_JUDGMENT_BATCH_SIZE = 20;

/**
 * One material assertion extracted from the artifact and assigned a stable,
 * code-owned identity before semantic judgment.
 */
export interface ExtractedArtifactAssertion {
  /**
   * Deterministic assertion identifier assigned in stable extraction order.
   */
  id: string;

  /**
   * Atomic assertion text returned by extraction.
   */
  statement: string;

  /**
   * Stable artifact section from which the assertion was extracted.
   */
  sectionId: string;

  /**
   * Wiki path owned by the source artifact section.
   */
  relativePath: string;
}

/**
 * Inputs for exhaustive bounded precision evaluation.
 */
export interface PrecisionPassInput {
  /**
   * Evaluator model used for extraction and semantic judgment.
   */
  model: BaseChatModel;

  /**
   * Checkpoint being evaluated.
   */
  checkpointId: string;

  /**
   * Complete artifact section set.
   */
  sections: ArtifactSection[];

  /**
   * Complete Truth Ledger fact set active at the checkpoint.
   */
  activeFacts: ActiveTruthFact[];

  /**
   * Number of complete sections supplied to each extraction request.
   *
   * @default 4
   */
  extractionBatchSize?: number;

  /**
   * Number of extracted assertions supplied to each judgment request.
   *
   * @default 20
   */
  judgmentBatchSize?: number;
}

/**
 * Compare strings using locale-independent code-unit ordering.
 *
 * @param a - First string.
 * @param b - Second string.
 *
 * @returns A negative number, zero, or a positive number for sorting.
 */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Split an ordered array into stable non-empty batches.
 *
 * @param values - Ordered values to batch.
 * @param size - Positive maximum batch size.
 *
 * @returns Stable batches preserving input order.
 */
function batch<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];

  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }

  return result;
}

/**
 * Validate a positive integer pass option.
 *
 * @param value - Configured numeric value.
 * @param name - Option name used in diagnostics.
 *
 * @throws EvaluationError when the value is not a positive integer.
 */
function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new EvaluationError(`${name} must be a positive integer.`);
  }
}

/**
 * Normalize assertion whitespace without changing its factual content.
 *
 * @param statement - Raw extracted assertion.
 *
 * @returns Trimmed assertion with internal whitespace collapsed.
 */
function normalizeStatement(statement: string): string {
  return statement.replace(/\s+/g, " ").trim();
}

/**
 * Produce the exact-deduplication key used by Precision V1.
 *
 * @param statement - Whitespace-normalized assertion.
 *
 * @returns Assertion with terminal punctuation removed for exact comparison.
 */
function deduplicationKey(statement: string): string {
  return statement.replace(/[.!?;:]+$/u, "").trim();
}

/**
 * Convert an artifact section into the extraction prompt's data-only shape.
 *
 * @param section - Complete artifact section.
 *
 * @returns Serializable extraction section.
 */
function toExtractionSection(
  section: ArtifactSection,
): PrecisionExtractionSection {
  return {
    sectionId: section.id,
    relativePath: section.relativePath,
    headingPath: section.headingPath,
    content: section.content,
  };
}

/**
 * Validate and restore extraction output to the supplied section order.
 *
 * @param sections - Complete sections supplied to one extraction request.
 * @param output - Parsed extraction response.
 *
 * @returns One assertion array per section in request order.
 *
 * @throws EvaluationError for unknown, duplicate, missing, or empty assertions.
 */
function resolveExtraction(
  sections: ArtifactSection[],
  output: AssertionExtractionOutput,
): Array<{ section: ArtifactSection; assertions: string[] }> {
  const requested = new Set(sections.map((section) => section.id));
  const byId = new Map<string, AssertionExtractionOutput["sections"][number]>();

  for (const result of output.sections) {
    if (!requested.has(result.sectionId)) {
      throw new EvaluationError(
        `Precision extractor returned unknown sectionId "${result.sectionId}".`,
      );
    }

    if (byId.has(result.sectionId)) {
      throw new EvaluationError(
        `Precision extractor returned sectionId "${result.sectionId}" more than once.`,
      );
    }

    for (const assertion of result.assertions) {
      const normalized = normalizeStatement(assertion);

      if (deduplicationKey(normalized).length === 0) {
        throw new EvaluationError(
          `Precision extractor returned an assertion containing only punctuation for sectionId "${result.sectionId}".`,
        );
      }
    }

    byId.set(result.sectionId, result);
  }

  return sections.map((section) => {
    const result = byId.get(section.id);

    if (result === undefined) {
      throw new EvaluationError(
        `Precision extractor returned no result for sectionId "${section.id}".`,
      );
    }

    return { section, assertions: result.assertions };
  });
}

/**
 * Extract, normalize, exactly deduplicate, and identify every material artifact
 * assertion while visiting each section exactly once.
 *
 * @param input - Precision pass configuration.
 * @param orderedSections - Complete sections in stable ID order.
 * @param extractionBatchSize - Validated extraction batch size.
 *
 * @returns Stable code-owned assertion inventory.
 */
async function extractAssertions(
  input: PrecisionPassInput,
  orderedSections: ArtifactSection[],
  extractionBatchSize: number,
): Promise<ExtractedArtifactAssertion[]> {
  const extracted: Array<{
    statement: string;
    sectionId: string;
    relativePath: string;
  }> = [];

  for (const sections of batch(orderedSections, extractionBatchSize)) {
    const output = await invokeStructuredModel({
      model: input.model,
      pass: "precision-extraction",
      checkpointId: input.checkpointId,
      systemPrompt: PRECISION_EXTRACTION_SYSTEM,
      taskPrompt: precisionExtractionPrompt(sections.map(toExtractionSection)),
      schema: assertionExtractionOutputSchema,
      validate: (parsed) => resolveExtraction(sections, parsed),
    });

    for (const result of resolveExtraction(sections, output)) {
      for (const rawStatement of result.assertions) {
        extracted.push({
          statement: normalizeStatement(rawStatement),
          sectionId: result.section.id,
          relativePath: result.section.relativePath,
        });
      }
    }
  }

  const seen = new Set<string>();
  const unique = extracted.filter((assertion) => {
    const key = deduplicationKey(assertion.statement);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });

  return unique.map((assertion, index) => ({
    id: `assertion-${String(index + 1).padStart(6, "0")}`,
    ...assertion,
  }));
}

/**
 * Convert active ledger facts to the judgment prompt's minimal data shape.
 *
 * @param activeFacts - Complete active Truth Ledger.
 *
 * @returns Stable fact identifiers and statements.
 */
function toJudgmentFacts(
  activeFacts: ActiveTruthFact[],
): PrecisionJudgmentFact[] {
  return activeFacts.map((fact) => ({
    factId: fact.factId,
    statement: fact.statement,
  }));
}

/**
 * Convert extracted assertions to the judgment prompt's minimal data shape.
 *
 * @param assertions - Code-owned assertion batch.
 *
 * @returns Assertion identifiers and statements.
 */
function toJudgmentAssertions(
  assertions: ExtractedArtifactAssertion[],
): PrecisionJudgmentAssertion[] {
  return assertions.map((assertion) => ({
    assertionId: assertion.id,
    statement: assertion.statement,
  }));
}

/**
 * Validate and resolve one precision-judgment response.
 *
 * @param assertions - Assertions supplied to the classifier.
 * @param activeFacts - Complete active Truth Ledger.
 * @param output - Parsed precision response.
 *
 * @returns External precision evaluations in assertion order.
 *
 * @throws EvaluationError for identity, completeness, or support-reference
 * violations.
 */
function resolveJudgments(
  assertions: ExtractedArtifactAssertion[],
  activeFacts: ActiveTruthFact[],
  output: PrecisionJudgmentOutput,
): PrecisionAssertionEvaluation[] {
  const requested = new Set(assertions.map((assertion) => assertion.id));
  const activeFactIds = new Set(activeFacts.map((fact) => fact.factId));
  const byId = new Map<
    string,
    PrecisionJudgmentOutput["evaluations"][number]
  >();

  for (const evaluation of output.evaluations) {
    if (!requested.has(evaluation.assertionId)) {
      throw new EvaluationError(
        `Precision classifier returned unknown assertionId "${evaluation.assertionId}".`,
      );
    }

    if (byId.has(evaluation.assertionId)) {
      throw new EvaluationError(
        `Precision classifier returned assertionId "${evaluation.assertionId}" more than once.`,
      );
    }

    const uniqueSupportingIds = new Set(evaluation.supportingFactIds);

    if (uniqueSupportingIds.size !== evaluation.supportingFactIds.length) {
      throw new EvaluationError(
        `Precision classifier returned duplicate supporting fact IDs for assertionId "${evaluation.assertionId}".`,
      );
    }

    for (const factId of evaluation.supportingFactIds) {
      if (!activeFactIds.has(factId)) {
        throw new EvaluationError(
          `Precision classifier cited unknown supporting factId "${factId}" for assertionId "${evaluation.assertionId}".`,
        );
      }
    }

    if (
      evaluation.verdict === "supported" &&
      evaluation.supportingFactIds.length === 0
    ) {
      throw new EvaluationError(
        `Precision classifier returned no supporting fact IDs for supported assertionId "${evaluation.assertionId}".`,
      );
    }

    if (
      evaluation.verdict === "unsupported" &&
      evaluation.supportingFactIds.length > 0
    ) {
      throw new EvaluationError(
        `Precision classifier returned supporting fact IDs for unsupported assertionId "${evaluation.assertionId}".`,
      );
    }

    byId.set(evaluation.assertionId, evaluation);
  }

  return assertions.map((assertion) => {
    const evaluation = byId.get(assertion.id);

    if (evaluation === undefined) {
      throw new EvaluationError(
        `Precision classifier returned no verdict for assertionId "${assertion.id}".`,
      );
    }

    return {
      assertion: assertion.statement,
      location: assertion.relativePath,
      verdict: evaluation.verdict,
      supportingFactIds: evaluation.supportingFactIds,
      rationale: evaluation.rationale,
    };
  });
}

/**
 * Run exhaustive bounded precision extraction and Truth-Ledger-based judgment.
 *
 * @param input - Precision pass configuration.
 *
 * @returns One judgment per unique normalized artifact assertion.
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

  const orderedSections = [...input.sections].sort((a, b) =>
    compareStrings(a.id, b.id),
  );
  const sectionIds = new Set(orderedSections.map((section) => section.id));

  if (sectionIds.size !== orderedSections.length) {
    throw new EvaluationError(
      "Precision input contains duplicate artifact section IDs.",
    );
  }

  if (orderedSections.length === 0) {
    return [];
  }

  const assertions = await extractAssertions(
    input,
    orderedSections,
    extractionBatchSize,
  );

  if (assertions.length === 0) {
    return [];
  }

  const activeFacts = toJudgmentFacts(input.activeFacts);
  const evaluations: PrecisionAssertionEvaluation[] = [];

  for (const assertionBatch of batch(assertions, judgmentBatchSize)) {
    const output = await invokeStructuredModel({
      model: input.model,
      pass: "precision-judgment",
      checkpointId: input.checkpointId,
      systemPrompt: PRECISION_JUDGMENT_SYSTEM,
      taskPrompt: precisionJudgmentPrompt(
        toJudgmentAssertions(assertionBatch),
        activeFacts,
      ),
      schema: precisionJudgmentOutputSchema,
      validate: (parsed) =>
        resolveJudgments(assertionBatch, input.activeFacts, parsed),
    });

    evaluations.push(
      ...resolveJudgments(assertionBatch, input.activeFacts, output),
    );
  }

  return evaluations;
}
