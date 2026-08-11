import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { EvaluationError } from "../core/errors.js";
import type {
  EvaluationWarning,
  FactEvaluation,
  SurfaceItem,
} from "../core/types.js";
import { invokeStructuredModel } from "./direct-model.js";
import type { ArtifactSection } from "./documents.js";
import {
  assertPositiveInteger,
  batch,
  createLimiter,
  DEFAULT_PASS_CONCURRENCY,
  mapWithLimit,
  toExcerpt,
  type Limiter,
} from "./pass-utils.js";
import {
  COVERAGE_SYSTEM,
  coveragePrompt,
  type CoveragePromptTarget,
} from "./prompts.js";
import type { SectionBm25Index } from "./retrieval.js";
import { coverageOutputSchema } from "./schemas.js";
import type { CoverageOutput } from "./schemas.js";

/**
 * Default number of BM25-ranked sections inspected in the first judgment.
 */
const DEFAULT_TOP_K = 8;

/**
 * Default number of fact targets included in each initial model request.
 *
 * Raised from the original conservative default now that a failed batch
 * degrades to per-item repair instead of aborting the run; larger batches cut
 * the serial round-trip count per checkpoint.
 */
const DEFAULT_TARGET_BATCH_SIZE = 15;

/**
 * Number of untried sections examined per exhaustive fallback request.
 */
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
   * Public source surface extracted at the checkpoint: the items the wiki is
   * expected to mention.
   */
  surface: SurfaceItem[];

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

  /**
   * Shared concurrency limiter bounding in-flight model calls across passes.
   *
   * @default a private limiter of `DEFAULT_PASS_CONCURRENCY` when absent, so a
   * standalone pass still runs its batches concurrently but never shares a
   * budget with sibling passes.
   */
  limit?: Limiter;

  /**
   * Optional sink for items that remain invalid after isolated repair.
   */
  onWarning?: (warning: EvaluationWarning) => void;
}

/**
 * Internal surface item paired with the exact sections visible to one model
 * judgment.
 */
interface CoverageTarget {
  /**
   * Surface item whose mention is being judged.
   */
  fact: SurfaceItem;

  /**
   * Artifact sections supplied as evidence candidates.
   */
  sections: ArtifactSection[];
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
 * Resolve raw coverage output into exactly one evaluation per requested surface
 * item. Unknown fact IDs, duplicate verdicts, and missing verdicts are
 * evaluation failures rather than implicit defaults.
 *
 * @param surface - Surface items requested from the classifier.
 * @param output - Parsed classifier output.
 *
 * @returns One evaluation per surface item in request order.
 *
 * @throws EvaluationError when output identity or completeness is invalid.
 */
export function resolveCoverage(
  surface: SurfaceItem[],
  output: CoverageOutput,
): FactEvaluation[] {
  const requested = new Set(surface.map((fact) => fact.factId));
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

  return surface.map((fact) => {
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
 * @throws EvaluationError when a citation was unavailable to the request or a
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
  const allowedSectionIds = new Set(
    targets.flatMap((target) => target.sections.map((section) => section.id)),
  );

  for (const evaluation of resolved) {
    for (const sectionId of evaluation.evidence) {
      if (!allowedSectionIds.has(sectionId)) {
        throw new EvaluationError(
          `Coverage evaluator cited unavailable sectionId "${sectionId}" for factId "${evaluation.factId}".`,
        );
      }
    }

    if (evaluation.verdict !== "missing" && evaluation.evidence.length === 0) {
      throw new EvaluationError(
        `Coverage evaluator returned no evidence for ${evaluation.verdict} factId "${evaluation.factId}".`,
      );
    }
  }
}

/**
 * Resolve and validate one coverage target from a possibly imperfect batch
 * response. Other targets' malformed or extra entries cannot invalidate this
 * item.
 *
 * @param target - Requirement being resolved.
 * @param output - Schema-valid batch response.
 * @param allowedSectionIds - Evidence identities visible anywhere in the batch.
 *
 * @returns One validated code-owned coverage evaluation.
 *
 * @throws EvaluationError when this target is missing, duplicated, invalid
 * by evidence, or cites unavailable evidence.
 */
function resolveCoverageItem(
  target: CoverageTarget,
  output: CoverageOutput,
  allowedSectionIds: Set<string>,
): FactEvaluation {
  const matches = output.evaluations.filter(
    (evaluation) => evaluation.factId === target.fact.factId,
  );

  if (matches.length !== 1) {
    throw new EvaluationError(
      `Coverage evaluator returned ${matches.length} verdicts for factId "${target.fact.factId}".`,
    );
  }

  const [evaluation] = matches;
  const uniqueEvidence = new Set(evaluation.evidence);

  if (uniqueEvidence.size !== evaluation.evidence.length) {
    throw new EvaluationError(
      `Coverage evaluator returned duplicate evidence for factId "${target.fact.factId}".`,
    );
  }

  for (const sectionId of evaluation.evidence) {
    if (!allowedSectionIds.has(sectionId)) {
      throw new EvaluationError(
        `Coverage evaluator cited unavailable sectionId "${sectionId}" for factId "${target.fact.factId}".`,
      );
    }
  }

  if (evaluation.verdict !== "missing" && evaluation.evidence.length === 0) {
    throw new EvaluationError(
      `Coverage evaluator returned no evidence for ${evaluation.verdict} factId "${target.fact.factId}".`,
    );
  }

  return {
    factId: target.fact.factId,
    factVersionId: target.fact.factVersionId,
    verdict: evaluation.verdict,
    evidence: evaluation.evidence,
    rationale: evaluation.rationale,
  };
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
 * Exhaustively scan every untried section for one still-`missing` requirement,
 * stopping at the first section batch that flips the verdict. The scan stays
 * strictly serial and early-breaks so it examines the minimum evidence, exactly
 * as when the fallback ran inline; only the per-target calls run concurrently.
 *
 * @param input - Coverage pass configuration and warning sink.
 * @param target - Requirement whose initial verdict was `missing`.
 * @param allSections - Every artifact section available as evidence.
 * @param initial - The initial `missing` evaluation retained when no section
 * flips the verdict.
 *
 * @returns The first non-missing verdict found, else the initial missing one.
 */
async function resolveCoverageFallback(
  input: CoveragePassInput,
  target: CoverageTarget,
  allSections: ArtifactSection[],
  initial: FactEvaluation,
): Promise<FactEvaluation> {
  const examined = new Set(target.sections.map((section) => section.id));
  const remaining = allSections.filter((section) => !examined.has(section.id));
  let evaluation = initial;

  for (const sections of batch(remaining, FALLBACK_SECTION_BATCH_SIZE)) {
    [evaluation] = await evaluateCoverageBatchResilient(input, [
      { fact: target.fact, sections },
    ]);

    if (evaluation.verdict !== "missing") {
      break;
    }
  }

  return evaluation;
}

/**
 * Evaluate a coverage batch without letting one malformed item discard valid
 * neighboring judgments. Invalid items receive one isolated structured request;
 * an item that still fails becomes explicitly indeterminate.
 *
 * @param input - Coverage pass configuration and warning sink.
 * @param targets - Requirements and excerpts included in the initial batch.
 *
 * @returns One valid or indeterminate evaluation per target.
 */
async function evaluateCoverageBatchResilient(
  input: CoveragePassInput,
  targets: CoverageTarget[],
): Promise<FactEvaluation[]> {
  // A whole-batch coverage failure (for example an empty or malformed tool-call
  // payload that survives both attempts inside invokeStructuredModel) must not
  // abort the pass. Fall back to an empty response and let the per-target loop
  // below re-evaluate each target in isolation, degrading only the targets that
  // still cannot be judged. The batch error is threaded into the degrade message
  // so the warning reports the real cause; it is already prompt-redacted and
  // length-bounded by invokeStructuredModel before it reaches here.
  let output: CoverageOutput;
  let batchError: unknown;
  try {
    output = await invokeStructuredModel({
      model: input.model,
      pass: "coverage",
      checkpointId: input.checkpointId,
      systemPrompt: COVERAGE_SYSTEM,
      taskPrompt: coveragePrompt(toPromptTargets(targets)),
      schema: coverageOutputSchema,
      timeoutMs: input.timeoutMs,
    });
  } catch (error) {
    batchError = error;
    output = { evaluations: [] };
  }
  const allowedSectionIds = new Set(
    targets.flatMap((target) => target.sections.map((section) => section.id)),
  );
  const evaluations: FactEvaluation[] = [];

  for (const target of targets) {
    try {
      evaluations.push(resolveCoverageItem(target, output, allowedSectionIds));
    } catch (initialError) {
      try {
        const [repaired] = await evaluateCoverageBatch(
          input.model,
          input.checkpointId,
          [target],
          input.timeoutMs,
        );
        evaluations.push(repaired);
      } catch (repairError) {
        const cause = batchError ?? initialError;
        const initialMessage =
          cause instanceof Error ? cause.message : String(cause);
        const repairMessage =
          repairError instanceof Error
            ? repairError.message
            : String(repairError);
        const message = `${initialMessage} Isolated repair failed: ${repairMessage}`;
        input.onWarning?.({
          pass: "coverage",
          itemId: target.fact.factId,
          message,
        });
        evaluations.push({
          factId: target.fact.factId,
          factVersionId: target.fact.factVersionId,
          verdict: "indeterminate",
          evidence: [],
          rationale: `Evaluator could not repair this coverage judgment: ${message}`,
        });
      }
    }
  }

  return evaluations;
}

/**
 * Run bounded coverage classification with BM25-first evidence and exhaustive
 * fallback before any `missing` verdict becomes final.
 *
 * @param input - Coverage pass configuration.
 *
 * @returns One coverage verdict per surface item in surface order.
 */
export async function runCoveragePass(
  input: CoveragePassInput,
): Promise<FactEvaluation[]> {
  if (input.surface.length === 0) {
    return [];
  }

  const topK = input.topK ?? DEFAULT_TOP_K;
  const batchSize = input.batchSize ?? DEFAULT_TARGET_BATCH_SIZE;
  const limit = input.limit ?? createLimiter(DEFAULT_PASS_CONCURRENCY);
  assertPositiveInteger(topK, "Coverage topK");
  assertPositiveInteger(batchSize, "Coverage batchSize");

  const allSections = input.index.sections();

  if (allSections.length === 0) {
    return input.surface.map((fact) => ({
      factId: fact.factId,
      factVersionId: fact.factVersionId,
      verdict: "missing",
      evidence: [],
      rationale: "The knowledge artifact contains no Markdown sections.",
    }));
  }

  const initialTargets = input.surface.map((fact): CoverageTarget => ({
    fact,
    sections: input.index
      .search(fact.statement, topK)
      .map((ranked) => ranked.section),
  }));
  const resultByFact = new Map<string, FactEvaluation>();

  const batchResults = await mapWithLimit(
    batch(initialTargets, batchSize),
    limit,
    (targets) => evaluateCoverageBatchResilient(input, targets),
  );

  for (const evaluations of batchResults) {
    for (const evaluation of evaluations) {
      resultByFact.set(evaluation.factId, evaluation);
    }
  }

  // Every still-missing requirement gets an independent exhaustive scan; the
  // targets are independent and each writes only its own result, so they run
  // concurrently while each scan's inner section walk stays serial.
  const missingTargets = initialTargets.filter(
    (target) =>
      (resultByFact.get(target.fact.factId) as FactEvaluation).verdict ===
      "missing",
  );
  const fallbackResults = await mapWithLimit(missingTargets, limit, (target) =>
    resolveCoverageFallback(
      input,
      target,
      allSections,
      resultByFact.get(target.fact.factId) as FactEvaluation,
    ),
  );

  for (const evaluation of fallbackResults) {
    resultByFact.set(evaluation.factId, evaluation);
  }

  return input.surface.map(
    (fact) => resultByFact.get(fact.factId) as FactEvaluation,
  );
}
