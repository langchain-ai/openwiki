import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { EvaluationError } from "../core/errors.js";
import type { ActiveTruthFact, FactEvaluation } from "../core/types.js";
import { invokeStructuredModel } from "./direct-model.js";
import type { ArtifactSection } from "./documents.js";
import {
  COVERAGE_SYSTEM,
  coveragePrompt,
  type CoveragePromptTarget,
  type EvaluationExcerpt,
} from "./prompts.js";
import type { SectionBm25Index } from "./retrieval.js";
import { coverageOutputSchema } from "./schemas.js";
import type { CoverageOutput } from "./schemas.js";

const DEFAULT_TOP_K = 8;
const DEFAULT_TARGET_BATCH_SIZE = 5;
const FALLBACK_SECTION_BATCH_SIZE = 8;

/**
 * Inputs for the bounded coverage pass.
 */
export interface CoveragePassInput {
  /**
   * Evaluator model used for direct structured judgments.
   */
  model: BaseChatModel;

  /**
   * Checkpoint being evaluated.
   */
  checkpointId: string;

  /**
   * Truth Ledger facts active at the checkpoint.
   */
  activeFacts: ActiveTruthFact[];

  /**
   * BM25 index over every Markdown artifact section.
   */
  index: SectionBm25Index;

  /**
   * Number of BM25-ranked sections inspected in the first judgment.
   *
   * @default 8
   */
  topK?: number;

  /**
   * Number of fact targets included in each initial model request.
   *
   * @default 5
   */
  batchSize?: number;

  /**
   * Per-attempt evaluator request deadline in milliseconds.
   */
  timeoutMs?: number;
}

/**
 * Internal active fact paired with the exact sections visible to one model
 * judgment.
 */
interface CoverageTarget {
  /**
   * Active ledger fact being judged.
   */
  fact: ActiveTruthFact;

  /**
   * Artifact sections supplied as evidence candidates.
   */
  sections: ArtifactSection[];
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
 * Convert an artifact section to the prompt's data-only excerpt shape.
 *
 * @param section - Artifact section selected for a judgment.
 *
 * @returns Serializable excerpt supplied to the model.
 */
function toExcerpt(section: ArtifactSection): EvaluationExcerpt {
  return {
    sectionId: section.id,
    relativePath: section.relativePath,
    headingPath: section.headingPath,
    content: section.content,
  };
}

/**
 * Convert internal coverage targets into their prompt representation.
 *
 * @param targets - Facts and sections included in one request.
 *
 * @returns Data-only prompt targets.
 */
function toPromptTargets(targets: CoverageTarget[]): CoveragePromptTarget[] {
  return targets.map(({ fact, sections }) => ({
    factId: fact.factId,
    statement: fact.statement,
    excerpts: sections.map(toExcerpt),
  }));
}

/**
 * Resolve raw coverage output into exactly one evaluation per requested fact.
 * Unknown fact IDs, duplicate verdicts, and missing verdicts are evaluation
 * failures rather than implicit defaults.
 *
 * @param activeFacts - Facts requested from the classifier.
 * @param output - Parsed classifier output.
 *
 * @returns One evaluation per fact in request order.
 *
 * @throws EvaluationError when output identity or completeness is invalid.
 */
export function resolveCoverage(
  activeFacts: ActiveTruthFact[],
  output: CoverageOutput,
): FactEvaluation[] {
  const requested = new Set(activeFacts.map((fact) => fact.factId));
  const byId = new Map<string, CoverageOutput["evaluations"][number]>();

  for (const evaluation of output.evaluations) {
    if (!requested.has(evaluation.factId)) {
      throw new EvaluationError(
        `Coverage evaluator returned a verdict for unknown factId "${evaluation.factId}".`,
      );
    }

    if (byId.has(evaluation.factId)) {
      throw new EvaluationError(
        `Coverage evaluator returned more than one verdict for factId "${evaluation.factId}".`,
      );
    }

    byId.set(evaluation.factId, evaluation);
  }

  return activeFacts.map((fact) => {
    const evaluation = byId.get(fact.factId);

    if (evaluation === undefined) {
      throw new EvaluationError(
        `Coverage evaluator returned no verdict for factId "${fact.factId}".`,
      );
    }

    return {
      factId: fact.factId,
      factVersionId: fact.factVersionId,
      verdict: evaluation.verdict,
      evidence: evaluation.evidence,
      rationale: evaluation.rationale,
    };
  });
}

/**
 * Validate evidence citations and evidence/verdict consistency for one request.
 *
 * @param targets - Facts and sections supplied to the model.
 * @param output - Parsed classifier output.
 *
 * @throws EvaluationError when a citation was unavailable to its fact or a
 * verdict has an invalid evidence shape.
 */
function validateCoverageOutput(
  targets: CoverageTarget[],
  output: CoverageOutput,
): void {
  const resolved = resolveCoverage(
    targets.map((target) => target.fact),
    output,
  );
  const allowedByFact = new Map(
    targets.map((target) => [
      target.fact.factId,
      new Set(target.sections.map((section) => section.id)),
    ]),
  );

  for (const evaluation of resolved) {
    const allowed = allowedByFact.get(evaluation.factId) as Set<string>;

    for (const sectionId of evaluation.evidence) {
      if (!allowed.has(sectionId)) {
        throw new EvaluationError(
          `Coverage evaluator cited unavailable sectionId "${sectionId}" for factId "${evaluation.factId}".`,
        );
      }
    }

    if (evaluation.verdict === "missing" && evaluation.evidence.length > 0) {
      throw new EvaluationError(
        `Coverage evaluator returned evidence for missing factId "${evaluation.factId}".`,
      );
    }

    if (evaluation.verdict !== "missing" && evaluation.evidence.length === 0) {
      throw new EvaluationError(
        `Coverage evaluator returned no evidence for ${evaluation.verdict} factId "${evaluation.factId}".`,
      );
    }
  }
}

/**
 * Run one bounded coverage request and resolve it to code-owned fact metadata.
 *
 * @param model - Evaluator model.
 * @param checkpointId - Checkpoint used for diagnostics.
 * @param targets - Facts and excerpts included in the request.
 * @param timeoutMs - Optional per-attempt request deadline.
 *
 * @returns One validated evaluation per target.
 */
async function evaluateCoverageBatch(
  model: BaseChatModel,
  checkpointId: string,
  targets: CoverageTarget[],
  timeoutMs?: number,
): Promise<FactEvaluation[]> {
  const output = await invokeStructuredModel({
    model,
    pass: "coverage",
    checkpointId,
    systemPrompt: COVERAGE_SYSTEM,
    taskPrompt: coveragePrompt(toPromptTargets(targets)),
    schema: coverageOutputSchema,
    validate: (parsed) => validateCoverageOutput(targets, parsed),
    timeoutMs,
  });

  return resolveCoverage(
    targets.map((target) => target.fact),
    output,
  );
}

/**
 * Run bounded coverage classification with BM25-first evidence and exhaustive
 * fallback before any `missing` verdict becomes final.
 *
 * @param input - Coverage pass configuration.
 *
 * @returns One coverage verdict per active fact in ledger order.
 */
export async function runCoveragePass(
  input: CoveragePassInput,
): Promise<FactEvaluation[]> {
  if (input.activeFacts.length === 0) {
    return [];
  }

  const topK = input.topK ?? DEFAULT_TOP_K;
  const batchSize = input.batchSize ?? DEFAULT_TARGET_BATCH_SIZE;
  assertPositiveInteger(topK, "Coverage topK");
  assertPositiveInteger(batchSize, "Coverage batchSize");

  const allSections = input.index.sections();

  if (allSections.length === 0) {
    return input.activeFacts.map((fact) => ({
      factId: fact.factId,
      factVersionId: fact.factVersionId,
      verdict: "missing",
      evidence: [],
      rationale: "The knowledge artifact contains no Markdown sections.",
    }));
  }

  const initialTargets = input.activeFacts.map((fact): CoverageTarget => ({
    fact,
    sections: input.index
      .search(fact.statement, topK)
      .map((ranked) => ranked.section),
  }));
  const resultByFact = new Map<string, FactEvaluation>();

  for (const targets of batch(initialTargets, batchSize)) {
    const evaluations = await evaluateCoverageBatch(
      input.model,
      input.checkpointId,
      targets,
      input.timeoutMs,
    );

    for (const evaluation of evaluations) {
      resultByFact.set(evaluation.factId, evaluation);
    }
  }

  for (const target of initialTargets) {
    const initial = resultByFact.get(target.fact.factId) as FactEvaluation;

    if (initial.verdict !== "missing") {
      continue;
    }

    const examined = new Set(target.sections.map((section) => section.id));
    const remaining = allSections.filter(
      (section) => !examined.has(section.id),
    );

    for (const sections of batch(remaining, FALLBACK_SECTION_BATCH_SIZE)) {
      const [evaluation] = await evaluateCoverageBatch(
        input.model,
        input.checkpointId,
        [{ fact: target.fact, sections }],
        input.timeoutMs,
      );

      resultByFact.set(target.fact.factId, evaluation);

      if (evaluation.verdict !== "missing") {
        break;
      }
    }
  }

  return input.activeFacts.map(
    (fact) => resultByFact.get(fact.factId) as FactEvaluation,
  );
}
