import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { EvaluationError } from "../core/errors.js";
import type {
  EvaluationWarning,
  ForgettingEvaluation,
  ObsoleteFactTarget,
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
  FORGETTING_SYSTEM,
  forgettingPrompt,
  type ForgettingPromptTarget,
} from "./prompts.js";
import type { SectionBm25Index } from "./retrieval.js";
import { forgettingOutputSchema } from "./schemas.js";
import type { ForgettingOutput } from "./schemas.js";

/**
 * Default number of BM25-ranked sections inspected in the first judgment.
 */
const DEFAULT_TOP_K = 8;

/**
 * Default number of obsolete targets included in each initial model request.
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
 * Internal obsolete target paired with the exact sections visible to one model
 * judgment.
 */
interface ForgettingTarget {
  /**
   * Obsolete requirement version being judged.
   */
  fact: ObsoleteFactTarget;

  /**
   * Artifact sections supplied as evidence candidates.
   */
  sections: ArtifactSection[];
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
 * Resolve and validate one forgetting target from a possibly imperfect batch
 * response without allowing neighboring items to invalidate it.
 *
 * @param target - Obsolete requirement version being resolved.
 * @param output - Schema-valid batch response.
 * @param allowedSectionIds - Evidence identities visible anywhere in the batch.
 *
 * @returns One validated code-owned forgetting evaluation.
 *
 * @throws EvaluationError when this target is missing, duplicated, lacks required
 * evidence, or cites unavailable evidence.
 */
function resolveForgettingItem(
  target: ForgettingTarget,
  output: ForgettingOutput,
  allowedSectionIds: Set<string>,
): ForgettingEvaluation {
  const matches = output.evaluations.filter(
    (evaluation) => evaluation.factVersionId === target.fact.factVersionId,
  );

  if (matches.length !== 1) {
    throw new EvaluationError(
      `Forgetting evaluator returned ${matches.length} verdicts for factVersionId "${target.fact.factVersionId}".`,
    );
  }

  const [evaluation] = matches;
  const uniqueEvidence = new Set(evaluation.evidence);

  if (uniqueEvidence.size !== evaluation.evidence.length) {
    throw new EvaluationError(
      `Forgetting evaluator returned duplicate evidence for factVersionId "${target.fact.factVersionId}".`,
    );
  }

  for (const sectionId of evaluation.evidence) {
    if (!allowedSectionIds.has(sectionId)) {
      throw new EvaluationError(
        `Forgetting evaluator cited unavailable sectionId "${sectionId}" for factVersionId "${target.fact.factVersionId}".`,
      );
    }
  }

  if (evaluation.verdict === "lingering" && evaluation.evidence.length === 0) {
    throw new EvaluationError(
      `Forgetting evaluator returned no evidence for lingering factVersionId "${target.fact.factVersionId}".`,
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
 * Exhaustively scan every untried section for one still-`forgotten` obsolete
 * version, stopping at the first section batch that finds it lingering. The scan
 * stays strictly serial and early-breaks so it examines the minimum evidence,
 * exactly as when the fallback ran inline; only the per-target calls run
 * concurrently.
 *
 * @param input - Forgetting pass configuration and warning sink.
 * @param target - Obsolete version whose initial verdict was `forgotten`.
 * @param allSections - Every artifact section available as evidence.
 * @param initial - The initial `forgotten` evaluation retained when no section
 * finds it lingering.
 *
 * @returns The first non-forgotten verdict found, else the initial forgotten
 * one.
 */
async function resolveForgettingFallback(
  input: ForgettingPassInput,
  target: ForgettingTarget,
  allSections: ArtifactSection[],
  initial: ForgettingEvaluation,
): Promise<ForgettingEvaluation> {
  const examined = new Set(target.sections.map((section) => section.id));
  const remaining = allSections.filter((section) => !examined.has(section.id));
  let evaluation = initial;

  for (const sections of batch(remaining, FALLBACK_SECTION_BATCH_SIZE)) {
    [evaluation] = await evaluateForgettingBatchResilient(input, [
      { fact: target.fact, sections },
    ]);

    if (evaluation.verdict !== "forgotten") {
      break;
    }
  }

  return evaluation;
}

/**
 * Evaluate a forgetting batch item by item, retrying only malformed items in
 * isolation and converting irreparable output into an explicit indeterminate
 * verdict.
 *
 * @param input - Forgetting pass configuration and warning sink.
 * @param targets - Obsolete versions and excerpts in the initial batch.
 *
 * @returns One valid or indeterminate evaluation per target.
 */
async function evaluateForgettingBatchResilient(
  input: ForgettingPassInput,
  targets: ForgettingTarget[],
): Promise<ForgettingEvaluation[]> {
  // A whole-batch forgetting failure (for example an empty or malformed
  // tool-call payload that survives both attempts inside invokeStructuredModel)
  // must not abort the pass. Fall back to an empty response and let the
  // per-target loop below re-evaluate each target in isolation, degrading only
  // the targets that still cannot be judged. The batch error is threaded into
  // the degrade message so the warning reports the real cause; it is already
  // prompt-redacted and length-bounded by invokeStructuredModel before it
  // reaches here.
  let output: ForgettingOutput;
  let batchError: unknown;
  try {
    output = await invokeStructuredModel({
      model: input.model,
      pass: "forgetting",
      checkpointId: input.checkpointId,
      systemPrompt: FORGETTING_SYSTEM,
      taskPrompt: forgettingPrompt(toPromptTargets(targets)),
      schema: forgettingOutputSchema,
      timeoutMs: input.timeoutMs,
    });
  } catch (error) {
    batchError = error;
    output = { evaluations: [] };
  }
  const allowedSectionIds = new Set(
    targets.flatMap((target) => target.sections.map((section) => section.id)),
  );
  const evaluations: ForgettingEvaluation[] = [];

  for (const target of targets) {
    try {
      evaluations.push(
        resolveForgettingItem(target, output, allowedSectionIds),
      );
    } catch (initialError) {
      try {
        const [repaired] = await evaluateForgettingBatch(
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
          pass: "forgetting",
          itemId: target.fact.factVersionId,
          message,
        });
        evaluations.push({
          factId: target.fact.factId,
          factVersionId: target.fact.factVersionId,
          verdict: "indeterminate",
          evidence: [],
          rationale: `Evaluator could not repair this forgetting judgment: ${message}`,
        });
      }
    }
  }

  return evaluations;
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
  const limit = input.limit ?? createLimiter(DEFAULT_PASS_CONCURRENCY);
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

  const batchResults = await mapWithLimit(
    batch(initialTargets, batchSize),
    limit,
    (targets) => evaluateForgettingBatchResilient(input, targets),
  );

  for (const evaluations of batchResults) {
    for (const evaluation of evaluations) {
      resultByVersion.set(evaluation.factVersionId, evaluation);
    }
  }

  // Every still-forgotten version gets an independent exhaustive scan; the
  // targets are independent and each writes only its own result, so they run
  // concurrently while each scan's inner section walk stays serial.
  const forgottenTargets = initialTargets.filter(
    (target) =>
      (resultByVersion.get(target.fact.factVersionId) as ForgettingEvaluation)
        .verdict === "forgotten",
  );
  const fallbackResults = await mapWithLimit(
    forgottenTargets,
    limit,
    (target) =>
      resolveForgettingFallback(
        input,
        target,
        allSections,
        resultByVersion.get(target.fact.factVersionId) as ForgettingEvaluation,
      ),
  );

  for (const evaluation of fallbackResults) {
    resultByVersion.set(evaluation.factVersionId, evaluation);
  }

  return input.obsoleteFacts.map(
    (fact) => resultByVersion.get(fact.factVersionId) as ForgettingEvaluation,
  );
}
