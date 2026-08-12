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
import { FORGETTING_SYSTEM, forgettingPrompt } from "./prompts.js";
import { SectionBm25Index } from "./retrieval.js";
import { forgettingOutputSchema } from "./schemas.js";
import type { ForgettingOutput } from "./schemas.js";

/** Default number of BM25-ranked sections inspected first. */
const DEFAULT_TOP_K = 8;

/** Default number of obsolete facts included in one initial request. */
const DEFAULT_TARGET_BATCH_SIZE = 15;

/** Number of untried sections examined per exhaustive fallback request. */
const FALLBACK_SECTION_BATCH_SIZE = 8;

/** Rationale used when the wiki contains no Markdown sections. */
const NO_SECTIONS_RATIONALE =
  "The knowledge artifact contains no Markdown sections.";

/** One obsolete fact paired with the wiki sections visible to its judgment. */
interface ForgettingTarget {
  fact: ObsoleteFactTarget;
  sections: ArtifactSection[];
}

/** Inputs for the bounded forgetting evaluator. */
export interface ForgettingPassInput {
  /** Evaluator model used for direct structured judgments. */
  model: BaseChatModel;

  /** Checkpoint being evaluated. */
  checkpointId: string;

  /** Obsolete fact versions that must no longer be asserted as current truth. */
  obsoleteFacts: ObsoleteFactTarget[];

  /** BM25 index over every Markdown artifact section. */
  index: SectionBm25Index;

  /** Number of BM25-ranked sections inspected first. @default 8 */
  topK?: number;

  /** Number of obsolete facts in an initial request. @default 15 */
  batchSize?: number;

  /** Optional per-attempt model deadline. */
  timeoutMs?: number;

  /** Shared concurrency limiter for evaluator model calls. */
  limit?: Limiter;

  /** Optional sink for judgments that remain invalid after isolated repair. */
  onWarning?: (warning: EvaluationWarning) => void;

  /** Optional sink for obsolete facts whose final verdict is complete. */
  onProgress?: (completed: number, total: number) => void;
}

/** Build the structured task prompt for a batch of obsolete facts. */
function buildPrompt(targets: ForgettingTarget[]): string {
  return forgettingPrompt(
    targets.map(({ fact, sections }) => ({
      factVersionId: fact.factVersionId,
      obsoleteStatement: fact.obsoleteStatement,
      excerpts: sections.map(toExcerpt),
    })),
  );
}

/** Convert one raw verdict to the code-owned forgetting result. */
function makeResult(
  fact: ObsoleteFactTarget,
  verdict: ForgettingEvaluation["verdict"],
  evidence: string[],
  rationale: string,
  matchedText?: string,
): ForgettingEvaluation {
  const result: ForgettingEvaluation = {
    factId: fact.factId,
    factVersionId: fact.factVersionId,
    verdict,
    evidence,
    rationale,
  };

  if (matchedText !== undefined) {
    result.matchedText = matchedText;
  }

  return result;
}

/**
 * Resolve raw output into exactly one result per requested obsolete version.
 * Unknown, duplicate, and missing identities are evaluation failures.
 */
export function resolveForgetting(
  obsoleteFacts: ObsoleteFactTarget[],
  output: ForgettingOutput,
): ForgettingEvaluation[] {
  const requested = new Set(obsoleteFacts.map((fact) => fact.factVersionId));
  const byId = new Map<string, ForgettingOutput["evaluations"][number]>();

  for (const item of output.evaluations) {
    if (!requested.has(item.factVersionId)) {
      throw new EvaluationError(
        `Forgetting evaluator returned a verdict for unknown factVersionId "${item.factVersionId}".`,
      );
    }
    if (byId.has(item.factVersionId)) {
      throw new EvaluationError(
        `Forgetting evaluator returned more than one verdict for factVersionId "${item.factVersionId}".`,
      );
    }
    byId.set(item.factVersionId, item);
  }

  return obsoleteFacts.map((fact) => {
    const item = byId.get(fact.factVersionId);
    if (item === undefined) {
      throw new EvaluationError(
        `Forgetting evaluator returned no verdict for factVersionId "${fact.factVersionId}".`,
      );
    }
    return makeResult(
      fact,
      item.verdict,
      item.evidence,
      item.rationale,
      item.matchedText,
    );
  });
}

/** Validate one raw verdict's citations and verbatim lingering evidence. */
function validateItemEvidence(
  item: ForgettingOutput["evaluations"][number],
  sectionsById: Map<string, ArtifactSection>,
): void {
  if (new Set(item.evidence).size !== item.evidence.length) {
    throw new EvaluationError(
      `Forgetting evaluator returned duplicate evidence for factVersionId "${item.factVersionId}".`,
    );
  }

  for (const sectionId of item.evidence) {
    if (!sectionsById.has(sectionId)) {
      throw new EvaluationError(
        `Forgetting evaluator cited unavailable sectionId "${sectionId}" for factVersionId "${item.factVersionId}".`,
      );
    }
  }

  if (item.verdict === "forgotten") {
    if (item.matchedText !== undefined) {
      throw new EvaluationError(
        `Forgetting evaluator returned matchedText for forgotten factVersionId "${item.factVersionId}".`,
      );
    }
    return;
  }

  if (item.evidence.length === 0) {
    throw new EvaluationError(
      `Forgetting evaluator returned no evidence for lingering factVersionId "${item.factVersionId}".`,
    );
  }
  if (item.matchedText === undefined) {
    throw new EvaluationError(
      `Forgetting evaluator returned no matchedText for lingering factVersionId "${item.factVersionId}".`,
    );
  }

  const quoteAppearsInCitation = item.evidence.some((sectionId) =>
    sectionsById.get(sectionId)?.content.includes(item.matchedText as string),
  );
  if (!quoteAppearsInCitation) {
    throw new EvaluationError(
      `Forgetting evaluator matchedText does not appear verbatim in cited evidence for factVersionId "${item.factVersionId}".`,
    );
  }
}

/** Validate identities and evidence citations for one complete request. */
function validateOutput(
  targets: ForgettingTarget[],
  output: ForgettingOutput,
): void {
  resolveForgetting(
    targets.map((target) => target.fact),
    output,
  );
  const sectionsById = new Map(
    targets.flatMap((target) =>
      target.sections.map((section) => [section.id, section] as const),
    ),
  );

  for (const item of output.evaluations) {
    validateItemEvidence(item, sectionsById);
  }
}

/** Resolve one target without allowing malformed neighbors to invalidate it. */
function resolveItem(
  target: ForgettingTarget,
  output: ForgettingOutput,
  sectionsById: Map<string, ArtifactSection>,
): ForgettingEvaluation {
  const matches = output.evaluations.filter(
    (item) => item.factVersionId === target.fact.factVersionId,
  );
  if (matches.length !== 1) {
    throw new EvaluationError(
      `Forgetting evaluator returned ${matches.length} verdicts for factVersionId "${target.fact.factVersionId}".`,
    );
  }

  const [item] = matches;
  validateItemEvidence(item, sectionsById);

  return makeResult(
    target.fact,
    item.verdict,
    item.evidence,
    item.rationale,
    item.matchedText,
  );
}

/** Invoke and strictly validate one complete forgetting request. */
async function evaluateBatch(
  input: ForgettingPassInput,
  targets: ForgettingTarget[],
): Promise<ForgettingEvaluation[]> {
  const output = await invokeStructuredModel({
    model: input.model,
    pass: "forgetting",
    checkpointId: input.checkpointId,
    systemPrompt: FORGETTING_SYSTEM,
    taskPrompt: buildPrompt(targets),
    schema: forgettingOutputSchema,
    validate: (parsed) => validateOutput(targets, parsed),
    timeoutMs: input.timeoutMs,
  });
  return resolveForgetting(
    targets.map((target) => target.fact),
    output,
  );
}

/**
 * Preserve valid batch neighbors, repair invalid targets in isolation, and
 * degrade only irreparable targets to an explicit indeterminate result.
 */
async function evaluateBatchResilient(
  input: ForgettingPassInput,
  targets: ForgettingTarget[],
): Promise<ForgettingEvaluation[]> {
  let output: ForgettingOutput;
  let batchError: unknown;

  try {
    output = await invokeStructuredModel({
      model: input.model,
      pass: "forgetting",
      checkpointId: input.checkpointId,
      systemPrompt: FORGETTING_SYSTEM,
      taskPrompt: buildPrompt(targets),
      schema: forgettingOutputSchema,
      timeoutMs: input.timeoutMs,
    });
  } catch (error) {
    batchError = error;
    output = { evaluations: [] };
  }

  const sectionsById = new Map(
    targets.flatMap((target) =>
      target.sections.map((section) => [section.id, section] as const),
    ),
  );
  const evaluations: ForgettingEvaluation[] = [];

  for (const target of targets) {
    try {
      evaluations.push(resolveItem(target, output, sectionsById));
    } catch (initialError) {
      try {
        const [repaired] = await evaluateBatch(input, [target]);
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
        evaluations.push(
          makeResult(
            target.fact,
            "indeterminate",
            [],
            `Evaluator could not repair this forgetting judgment: ${message}`,
          ),
        );
      }
    }
  }

  return evaluations;
}

/** Exhaustively scan untried sections until an obsolete fact is found lingering. */
async function resolveFallback(
  input: ForgettingPassInput,
  target: ForgettingTarget,
  allSections: ArtifactSection[],
  initial: ForgettingEvaluation,
): Promise<ForgettingEvaluation> {
  const examined = new Set(target.sections.map((section) => section.id));
  const remaining = allSections.filter((section) => !examined.has(section.id));
  let evaluation = initial;

  for (const sections of batch(remaining, FALLBACK_SECTION_BATCH_SIZE)) {
    [evaluation] = await evaluateBatchResilient(input, [
      { fact: target.fact, sections },
    ]);
    if (evaluation.verdict !== "forgotten") {
      break;
    }
  }

  return evaluation;
}

/**
 * Judge every obsolete fact with BM25-first evidence and an exhaustive fallback
 * before any evidence-free `forgotten` verdict becomes final.
 */
export async function runForgettingPass(
  input: ForgettingPassInput,
): Promise<ForgettingEvaluation[]> {
  if (input.obsoleteFacts.length === 0) {
    input.onProgress?.(0, 0);
    return [];
  }

  const topK = input.topK ?? DEFAULT_TOP_K;
  const batchSize = input.batchSize ?? DEFAULT_TARGET_BATCH_SIZE;
  const limit = input.limit ?? createLimiter(DEFAULT_PASS_CONCURRENCY);
  assertPositiveInteger(topK, "Forgetting topK");
  assertPositiveInteger(batchSize, "Forgetting batchSize");

  const allSections = input.index.sections();
  if (allSections.length === 0) {
    const evaluations = input.obsoleteFacts.map((fact) =>
      makeResult(fact, "forgotten", [], NO_SECTIONS_RATIONALE),
    );
    input.onProgress?.(evaluations.length, evaluations.length);
    return evaluations;
  }

  const initialTargets = input.obsoleteFacts.map((fact): ForgettingTarget => ({
    fact,
    sections: input.index
      .search(fact.obsoleteStatement, topK)
      .map((ranked) => ranked.section),
  }));
  const resultById = new Map<string, ForgettingEvaluation>();
  const batchResults = await mapWithLimit(
    batch(initialTargets, batchSize),
    limit,
    (targets) => evaluateBatchResilient(input, targets),
  );

  for (const evaluations of batchResults) {
    for (const evaluation of evaluations) {
      resultById.set(evaluation.factVersionId, evaluation);
    }
  }

  const forgottenTargets = initialTargets.filter(
    (target) =>
      resultById.get(target.fact.factVersionId)?.verdict === "forgotten",
  );
  let completed = input.obsoleteFacts.length - forgottenTargets.length;
  input.onProgress?.(completed, input.obsoleteFacts.length);
  const fallbackResults = await mapWithLimit(
    forgottenTargets,
    limit,
    async (target) => {
      const evaluation = await resolveFallback(
        input,
        target,
        allSections,
        resultById.get(target.fact.factVersionId) as ForgettingEvaluation,
      );
      completed += 1;
      input.onProgress?.(completed, input.obsoleteFacts.length);
      return evaluation;
    },
  );

  for (const evaluation of fallbackResults) {
    resultById.set(evaluation.factVersionId, evaluation);
  }

  return input.obsoleteFacts.map(
    (fact) => resultById.get(fact.factVersionId) as ForgettingEvaluation,
  );
}
