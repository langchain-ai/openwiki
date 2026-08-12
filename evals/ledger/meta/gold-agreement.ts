import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { readFile } from "node:fs/promises";

import { EvaluationError } from "../core/errors.js";
import type { PrecisionClaimTense } from "../core/types.js";
import { invokeStructuredModel } from "../evaluator/direct-model.js";
import {
  PRECISION_EXTRACTION_SYSTEM,
  PRECISION_JUDGMENT_SYSTEM,
  precisionExtractionPrompt,
  precisionJudgmentPrompt,
  type PrecisionEvidenceExcerpt,
} from "../evaluator/prompts.js";
import {
  assertionExtractionOutputSchema,
  precisionJudgmentOutputSchema,
} from "../evaluator/schemas.js";
import type { PrecisionTextUnitClassification } from "../evaluator/precision.js";

/**
 * Minimum acceptable live judge agreement for every semantic stage.
 */
const GOLD_AGREEMENT_FLOOR = 0.9;

/**
 * One human-labeled expected claim in a gold fixture case.
 */
interface ExpectedAssertion {
  /**
   * Expected claim text.
   */
  statement: string;

  /**
   * Exact contiguous fixture text supporting the normalized claim.
   */
  sourceQuote: string;

  /**
   * Expected claim tense.
   */
  tense: PrecisionClaimTense;
}

/**
 * Human-reviewed calibration cases for the live precision stages.
 */
export interface PrecisionGoldFixture {
  /**
   * Human-readable summary of what the fixture covers.
   */
  description: string;

  /**
   * Extraction/classification calibration cases.
   */
  extractionCases: Array<{
    /**
     * Text unit presented to the extractor.
     */
    content: string;

    /**
     * Expected classification and extracted claims.
     */
    expected: {
      classification: PrecisionTextUnitClassification;
      assertions: ExpectedAssertion[];
    };
  }>;

  /**
   * Source-grounding calibration cases.
   */
  groundingCases: Array<{
    /**
     * Claim being grounded against source evidence.
     */
    assertion: string;

    /**
     * Exact artifact span from which the assertion was normalized.
     *
     * @default The assertion text
     */
    sourceQuote?: string;

    /**
     * Complete artifact unit constraining the quote's scope and tense.
     *
     * @default The assertion text
     */
    artifactContext?: string;

    /**
     * Evidence excerpts visible to the grounding.
     */
    evidence: PrecisionEvidenceExcerpt[];

    /**
     * Expected grounding verdict.
     */
    expected: {
      verdict: "supported" | "contradicted" | "not-addressed";

      /**
       * Expected formerly-true flag for a contradicted verdict.
       *
       * @default undefined for a supported or not-addressed expected verdict
       */
      formerlyTrue?: boolean;
    };
  }>;
}

/**
 * Exact judge-vs-human agreement for one semantic stage.
 */
export interface StageAgreement {
  /**
   * Number of cases the judge matched the human label on.
   */
  correct: number;

  /**
   * Total cases evaluated for the stage.
   */
  total: number;

  /**
   * Fraction correct, or 1 when the stage had no cases.
   */
  agreement: number;

  /**
   * Human-readable descriptions of each mismatched case.
   */
  mismatches: string[];
}

/**
 * Full calibration report across all semantic stages.
 */
export interface GoldAgreementReport {
  /**
   * Extraction/classification stage agreement.
   */
  extraction: StageAgreement;

  /**
   * Source-grounding stage agreement.
   */
  grounding: StageAgreement;

  /**
   * Minimum agreement each stage must reach.
   */
  floor: number;

  /**
   * Whether every stage met the floor.
   */
  passed: boolean;
}

/**
 * Load the committed human-reviewed precision calibration set.
 */
export async function loadPrecisionGoldFixture(): Promise<PrecisionGoldFixture> {
  return JSON.parse(
    await readFile(
      new URL("../evaluator/fixtures/precision-gold.json", import.meta.url),
      "utf8",
    ),
  ) as PrecisionGoldFixture;
}

/**
 * Assemble one stage's agreement record, treating an empty stage as full
 * agreement.
 *
 * @param correct - Number of matched cases.
 * @param total - Total cases evaluated.
 * @param mismatches - Descriptions of mismatched cases.
 *
 * @returns The stage agreement record.
 */
function stageAgreement(
  correct: number,
  total: number,
  mismatches: string[] = [],
): StageAgreement {
  return {
    correct,
    total,
    agreement: total === 0 ? 1 : correct / total,
    mismatches,
  };
}

/**
 * Compare two values by their canonical JSON serialization.
 *
 * @param first - First value.
 * @param second - Second value.
 *
 * @returns Whether the two values serialize identically.
 */
function sameJson(first: unknown, second: unknown): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

/**
 * Run every live semantic stage and report exact judge-vs-human agreement.
 */
export async function measureGoldAgreement(inputs: {
  model: BaseChatModel;
  fixture?: PrecisionGoldFixture;
  timeoutMs?: number;
}): Promise<GoldAgreementReport> {
  const fixture = inputs.fixture ?? (await loadPrecisionGoldFixture());
  const extractionUnits = fixture.extractionCases.map((item, index) => ({
    unitId: `gold-unit-${index}`,
    sectionId: `gold-section-${index}`,
    relativePath: `gold-${index}.md`,
    headingPath: [],
    content: item.content,
  }));
  const extraction = await invokeStructuredModel({
    model: inputs.model,
    pass: "precision-extraction",
    checkpointId: "gold",
    systemPrompt: PRECISION_EXTRACTION_SYSTEM,
    taskPrompt: precisionExtractionPrompt(extractionUnits),
    schema: assertionExtractionOutputSchema,
    timeoutMs: inputs.timeoutMs,
  });
  const extractionById = new Map(
    extraction.units.map((unit) => [unit.unitId, unit]),
  );
  let extractionCorrect = 0;
  const extractionMismatches: string[] = [];
  for (const [index, item] of fixture.extractionCases.entries()) {
    const actual = extractionById.get(`gold-unit-${index}`);
    if (
      actual?.classification === item.expected.classification &&
      sameJson(actual.assertions, item.expected.assertions)
    ) {
      extractionCorrect += 1;
    } else {
      extractionMismatches.push(
        `case ${index}: expected ${JSON.stringify(item.expected)}, received ${JSON.stringify(actual === undefined ? null : { classification: actual.classification, assertions: actual.assertions })}`,
      );
    }
  }

  let groundingCorrect = 0;
  const groundingMismatches: string[] = [];
  for (const [index, item] of fixture.groundingCases.entries()) {
    const assertionId = `gold-grounding-${index}`;
    const output = await invokeStructuredModel({
      model: inputs.model,
      pass: "precision-judgment",
      checkpointId: "gold",
      systemPrompt: PRECISION_JUDGMENT_SYSTEM,
      taskPrompt: precisionJudgmentPrompt(
        [
          {
            assertionId,
            statement: item.assertion,
            sourceQuote: item.sourceQuote ?? item.assertion,
            artifactContextId: `gold-grounding-context-${index}`,
            tense: "current",
            evidenceIds: item.evidence.map((evidence) => evidence.evidenceId),
          },
        ],
        item.evidence,
        [
          {
            contextId: `gold-grounding-context-${index}`,
            relativePath: `gold-grounding-${index}.md`,
            headingPath: [],
            content: item.artifactContext ?? item.assertion,
          },
        ],
      ),
      schema: precisionJudgmentOutputSchema,
      timeoutMs: inputs.timeoutMs,
    });
    const actual = output.evaluations.find(
      (evaluation) => evaluation.assertionId === assertionId,
    );
    if (
      actual?.verdict === item.expected.verdict &&
      actual.formerlyTrue === item.expected.formerlyTrue
    ) {
      groundingCorrect += 1;
    } else {
      groundingMismatches.push(
        `case ${index}: expected ${JSON.stringify(item.expected)}, received ${JSON.stringify(actual === undefined ? null : { verdict: actual.verdict, formerlyTrue: actual.formerlyTrue })}`,
      );
    }
  }

  const report: GoldAgreementReport = {
    extraction: stageAgreement(
      extractionCorrect,
      fixture.extractionCases.length,
      extractionMismatches,
    ),
    grounding: stageAgreement(
      groundingCorrect,
      fixture.groundingCases.length,
      groundingMismatches,
    ),
    floor: GOLD_AGREEMENT_FLOOR,
    passed: false,
  };
  report.passed = [report.extraction, report.grounding].every(
    (stage) => stage.agreement >= GOLD_AGREEMENT_FLOOR,
  );
  return report;
}

/**
 * Throw a bounded calibration failure when any stage misses the agreement gate.
 */
export function assertGoldAgreement(report: GoldAgreementReport): void {
  if (!report.passed) {
    throw new EvaluationError(
      `Precision gold agreement below ${GOLD_AGREEMENT_FLOOR}: extraction=${report.extraction.agreement}, grounding=${report.grounding.agreement}.`,
    );
  }
}
