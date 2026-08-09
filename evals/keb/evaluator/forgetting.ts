import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { EvaluationError } from "../core/errors.js";
import type {
  ForgettingEvaluation,
  ObsoleteFactTarget,
} from "../core/types.js";
import { invokeStructuredModel } from "./direct-model.js";
import type { ArtifactSection } from "./documents.js";
import {
  FORGETTING_SYSTEM,
  forgettingPrompt,
  type EvaluationExcerpt,
  type ForgettingPromptTarget,
} from "./prompts.js";
import type { SectionBm25Index } from "./retrieval.js";
import { forgettingOutputSchema } from "./schemas.js";
import type { ForgettingOutput } from "./schemas.js";

const DEFAULT_TOP_K = 8;
const DEFAULT_TARGET_BATCH_SIZE = 5;
const FALLBACK_SECTION_BATCH_SIZE = 8;

/**
 * Inputs for the bounded forgetting pass.
 */
export interface ForgettingPassInput {
  /**
   * Evaluator model used for direct structured judgments.
   */
  model: BaseChatModel;

  /**
   * Checkpoint being evaluated.
   */
  checkpointId: string;

  /**
   * Obsolete fact versions that must no longer be asserted as current truth.
   */
  obsoleteFacts: ObsoleteFactTarget[];

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
   * Number of obsolete targets included in each initial model request.
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
 * Internal obsolete target paired with the exact sections visible to one model
 * judgment.
 */
interface ForgettingTarget {
  /**
   * Obsolete ledger fact version being judged.
   */
  fact: ObsoleteFactTarget;

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
 * Convert internal forgetting targets into their prompt representation.
 *
 * @param targets - Obsolete facts and sections included in one request.
 *
 * @returns Data-only prompt targets.
 */
function toPromptTargets(
  targets: ForgettingTarget[],
): ForgettingPromptTarget[] {
  return targets.map(({ fact, sections }) => ({
    factVersionId: fact.factVersionId,
    obsoleteStatement: fact.obsoleteStatement,
    excerpts: sections.map(toExcerpt),
  }));
}

/**
 * Resolve raw forgetting output into exactly one evaluation per requested
 * obsolete version. Unknown, duplicate, and missing verdicts are failures.
 *
 * @param obsoleteFacts - Obsolete versions requested from the classifier.
 * @param output - Parsed classifier output.
 *
 * @returns One evaluation per obsolete version in request order.
 *
 * @throws EvaluationError when output identity or completeness is invalid.
 */
export function resolveForgetting(
  obsoleteFacts: ObsoleteFactTarget[],
  output: ForgettingOutput,
): ForgettingEvaluation[] {
  const requested = new Set(
    obsoleteFacts.map((target) => target.factVersionId),
  );
  const byId = new Map<string, ForgettingOutput["evaluations"][number]>();

  for (const evaluation of output.evaluations) {
    if (!requested.has(evaluation.factVersionId)) {
      throw new EvaluationError(
        `Forgetting evaluator returned a verdict for unknown factVersionId "${evaluation.factVersionId}".`,
      );
    }

    if (byId.has(evaluation.factVersionId)) {
      throw new EvaluationError(
        `Forgetting evaluator returned more than one verdict for factVersionId "${evaluation.factVersionId}".`,
      );
    }

    byId.set(evaluation.factVersionId, evaluation);
  }

  return obsoleteFacts.map((target) => {
    const evaluation = byId.get(target.factVersionId);

    if (evaluation === undefined) {
      throw new EvaluationError(
        `Forgetting evaluator returned no verdict for factVersionId "${target.factVersionId}".`,
      );
    }

    return {
      factId: target.factId,
      factVersionId: target.factVersionId,
      verdict: evaluation.verdict,
      evidence: evaluation.evidence,
      rationale: evaluation.rationale,
    };
  });
}

/**
 * Validate evidence citations and evidence/verdict consistency for one request.
 *
 * @param targets - Obsolete facts and sections supplied to the model.
 * @param output - Parsed classifier output.
 *
 * @throws EvaluationError when a citation was unavailable to the request or a
 * verdict has an invalid evidence shape.
 */
function validateForgettingOutput(
  targets: ForgettingTarget[],
  output: ForgettingOutput,
): void {
  const resolved = resolveForgetting(
    targets.map((target) => target.fact),
    output,
  );
  const allowedSectionIds = new Set(
    targets.flatMap((target) => target.sections.map((section) => section.id)),
  );

  for (const evaluation of resolved) {
    for (const sectionId of evaluation.evidence) {
      if (!allowedSectionIds.has(sectionId)) {
        throw new EvaluationError(
          `Forgetting evaluator cited unavailable sectionId "${sectionId}" for factVersionId "${evaluation.factVersionId}".`,
        );
      }
    }

    if (
      evaluation.verdict === "lingering" &&
      evaluation.evidence.length === 0
    ) {
      throw new EvaluationError(
        `Forgetting evaluator returned no evidence for lingering factVersionId "${evaluation.factVersionId}".`,
      );
    }
  }
}

/**
 * Run one bounded forgetting request and resolve it to code-owned fact metadata.
 *
 * @param model - Evaluator model.
 * @param checkpointId - Checkpoint used for diagnostics.
 * @param targets - Obsolete facts and excerpts included in the request.
 * @param timeoutMs - Optional per-attempt request deadline.
 *
 * @returns One validated evaluation per target.
 */
async function evaluateForgettingBatch(
  model: BaseChatModel,
  checkpointId: string,
  targets: ForgettingTarget[],
  timeoutMs?: number,
): Promise<ForgettingEvaluation[]> {
  const output = await invokeStructuredModel({
    model,
    pass: "forgetting",
    checkpointId,
    systemPrompt: FORGETTING_SYSTEM,
    taskPrompt: forgettingPrompt(toPromptTargets(targets)),
    schema: forgettingOutputSchema,
    validate: (parsed) => validateForgettingOutput(targets, parsed),
    timeoutMs,
  });

  return resolveForgetting(
    targets.map((target) => target.fact),
    output,
  );
}

/**
 * Run bounded obsolete-knowledge classification with BM25-first evidence and
 * exhaustive fallback before any `forgotten` verdict becomes final.
 *
 * @param input - Forgetting pass configuration.
 *
 * @returns One forgetting verdict per obsolete version in input order.
 */
export async function runForgettingPass(
  input: ForgettingPassInput,
): Promise<ForgettingEvaluation[]> {
  if (input.obsoleteFacts.length === 0) {
    return [];
  }

  const topK = input.topK ?? DEFAULT_TOP_K;
  const batchSize = input.batchSize ?? DEFAULT_TARGET_BATCH_SIZE;
  assertPositiveInteger(topK, "Forgetting topK");
  assertPositiveInteger(batchSize, "Forgetting batchSize");

  const allSections = input.index.sections();

  if (allSections.length === 0) {
    return input.obsoleteFacts.map((fact) => ({
      factId: fact.factId,
      factVersionId: fact.factVersionId,
      verdict: "forgotten",
      evidence: [],
      rationale: "The knowledge artifact contains no Markdown sections.",
    }));
  }

  const initialTargets = input.obsoleteFacts.map((fact): ForgettingTarget => ({
    fact,
    sections: input.index
      .search(fact.obsoleteStatement, topK)
      .map((ranked) => ranked.section),
  }));
  const resultByVersion = new Map<string, ForgettingEvaluation>();

  for (const targets of batch(initialTargets, batchSize)) {
    const evaluations = await evaluateForgettingBatch(
      input.model,
      input.checkpointId,
      targets,
      input.timeoutMs,
    );

    for (const evaluation of evaluations) {
      resultByVersion.set(evaluation.factVersionId, evaluation);
    }
  }

  for (const target of initialTargets) {
    const initial = resultByVersion.get(
      target.fact.factVersionId,
    ) as ForgettingEvaluation;

    if (initial.verdict === "lingering") {
      continue;
    }

    const examined = new Set(target.sections.map((section) => section.id));
    const remaining = allSections.filter(
      (section) => !examined.has(section.id),
    );

    for (const sections of batch(remaining, FALLBACK_SECTION_BATCH_SIZE)) {
      const [evaluation] = await evaluateForgettingBatch(
        input.model,
        input.checkpointId,
        [{ fact: target.fact, sections }],
        input.timeoutMs,
      );

      resultByVersion.set(target.fact.factVersionId, evaluation);

      if (evaluation.verdict === "lingering") {
        break;
      }
    }
  }

  return input.obsoleteFacts.map(
    (fact) => resultByVersion.get(fact.factVersionId) as ForgettingEvaluation,
  );
}
