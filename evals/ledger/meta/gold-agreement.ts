import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { readFile } from "node:fs/promises";

import { EvaluationError } from "../core/errors.js";
import type { PrecisionClaimTense } from "../core/types.js";
import { invokeStructuredModel } from "../evaluator/direct-model.js";
import {
  PRECISION_EXTRACTION_SYSTEM,
  PRECISION_JUDGMENT_SYSTEM,
  PRECISION_LEDGER_SYSTEM,
  precisionExtractionPrompt,
  precisionJudgmentPrompt,
  precisionLedgerPrompt,
  type PrecisionEvidenceExcerpt,
  type PrecisionLedgerFact,
} from "../evaluator/prompts.js";
import {
  assertionExtractionOutputSchema,
  precisionJudgmentOutputSchema,
  precisionLedgerOutputSchema,
} from "../evaluator/schemas.js";
import type { PrecisionTextUnitClassification } from "../evaluator/precision.js";

/** Minimum acceptable live judge agreement for every semantic stage. */
export const GOLD_AGREEMENT_FLOOR = 0.9;

interface ExpectedAssertion {
  statement: string;
  tense: PrecisionClaimTense;
}

export interface PrecisionGoldFixture {
  description: string;
  extractionCases: Array<{
    content: string;
    expected: {
      classification: PrecisionTextUnitClassification;
      assertions: ExpectedAssertion[];
    };
  }>;
  ledgerCases: Array<{
    assertion: ExpectedAssertion;
    facts: PrecisionLedgerFact[];
    expected: {
      verdict: "supported" | "contradicted" | "unaccounted";
      formerlyTrue?: boolean;
    };
  }>;
  refutationCases: Array<{
    assertion: string;
    evidence: PrecisionEvidenceExcerpt[];
    expected: {
      verdict: "contradicted" | "not-refuted";
      formerlyTrue?: boolean;
    };
  }>;
}

export interface StageAgreement {
  correct: number;
  total: number;
  agreement: number;
  mismatches: string[];
}

export interface GoldAgreementReport {
  extraction: StageAgreement;
  ledger: StageAgreement;
  refutation: StageAgreement;
  floor: number;
  passed: boolean;
}

/** Load the committed human-reviewed precision calibration set. */
export async function loadPrecisionGoldFixture(): Promise<PrecisionGoldFixture> {
  return JSON.parse(
    await readFile(
      new URL("../evaluator/fixtures/precision-gold.json", import.meta.url),
      "utf8",
    ),
  ) as PrecisionGoldFixture;
}

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

function sameJson(first: unknown, second: unknown): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

/** Run all three live semantic stages and report exact judge-vs-human agreement. */
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
  const extractionCorrect = fixture.extractionCases.filter((item, index) => {
    const actual = extractionById.get(`gold-unit-${index}`);
    return (
      actual?.classification === item.expected.classification &&
      sameJson(actual.assertions, item.expected.assertions)
    );
  }).length;

  let ledgerCorrect = 0;
  const ledgerMismatches: string[] = [];
  for (const [index, item] of fixture.ledgerCases.entries()) {
    const assertionId = `gold-ledger-${index}`;
    const output = await invokeStructuredModel({
      model: inputs.model,
      pass: "precision-ledger",
      checkpointId: "gold",
      systemPrompt: PRECISION_LEDGER_SYSTEM,
      taskPrompt: precisionLedgerPrompt(
        [{ assertionId, ...item.assertion }],
        item.facts,
      ),
      schema: precisionLedgerOutputSchema,
      timeoutMs: inputs.timeoutMs,
    });
    const actual = output.evaluations.find(
      (evaluation) => evaluation.assertionId === assertionId,
    );
    if (
      actual?.verdict === item.expected.verdict &&
      actual.formerlyTrue === item.expected.formerlyTrue
    ) {
      ledgerCorrect += 1;
    } else {
      ledgerMismatches.push(
        `case ${index}: expected ${JSON.stringify(item.expected)}, received ${JSON.stringify(actual === undefined ? null : { verdict: actual.verdict, formerlyTrue: actual.formerlyTrue })}`,
      );
    }
  }

  let refutationCorrect = 0;
  const refutationMismatches: string[] = [];
  for (const [index, item] of fixture.refutationCases.entries()) {
    const assertionId = `gold-refutation-${index}`;
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
            tense: "current",
            evidenceIds: item.evidence.map((evidence) => evidence.evidenceId),
          },
        ],
        item.evidence,
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
      refutationCorrect += 1;
    } else {
      refutationMismatches.push(
        `case ${index}: expected ${JSON.stringify(item.expected)}, received ${JSON.stringify(actual === undefined ? null : { verdict: actual.verdict, formerlyTrue: actual.formerlyTrue })}`,
      );
    }
  }

  const report: GoldAgreementReport = {
    extraction: stageAgreement(
      extractionCorrect,
      fixture.extractionCases.length,
    ),
    ledger: stageAgreement(
      ledgerCorrect,
      fixture.ledgerCases.length,
      ledgerMismatches,
    ),
    refutation: stageAgreement(
      refutationCorrect,
      fixture.refutationCases.length,
      refutationMismatches,
    ),
    floor: GOLD_AGREEMENT_FLOOR,
    passed: false,
  };
  report.passed = [report.extraction, report.ledger, report.refutation].every(
    (stage) => stage.agreement >= GOLD_AGREEMENT_FLOOR,
  );
  return report;
}

/** Throw a bounded calibration failure when any stage misses the agreement gate. */
export function assertGoldAgreement(report: GoldAgreementReport): void {
  if (!report.passed) {
    throw new EvaluationError(
      `Precision gold agreement below ${GOLD_AGREEMENT_FLOOR}: extraction=${report.extraction.agreement}, ledger=${report.ledger.agreement}, refutation=${report.refutation.agreement}.`,
    );
  }
}
