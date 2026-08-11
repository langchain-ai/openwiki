import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ZodType } from "zod";

import { EvaluationError } from "../core/errors.js";
import type { EvaluationWarning } from "../core/types.js";
import {
  invokeStructuredModel,
  type DirectEvaluationPass,
} from "./direct-model.js";
import type { ArtifactSection } from "./documents.js";
import {
  assertPositiveInteger,
  batch,
  createLimiter,
  DEFAULT_PASS_CONCURRENCY,
  mapWithLimit,
  type Limiter,
} from "./pass-utils.js";
import type { SectionBm25Index } from "./retrieval.js";

/**
 * Default number of BM25-ranked sections inspected in the first judgment.
 */
const DEFAULT_TOP_K = 8;

/**
 * Default number of targets included in each initial model request.
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
 * Rationale recorded for every target when the artifact contains no Markdown
 * sections at all, so there is nothing any judgment could cite.
 */
const NO_SECTIONS_RATIONALE =
  "The knowledge artifact contains no Markdown sections.";

/**
 * The minimum shape a raw classifier output item must have for the shared engine
 * to reconcile it. The pass-specific identity field (`factId` or
 * `factVersionId`) is read through the spec's `itemId` accessor, so it is not
 * required here.
 */
export interface PassOutputItem {
  /**
   * The label the classifier committed to for this target.
   */
  verdict: string;

  /**
   * Cited artifact section ids supporting the verdict.
   */
  evidence: string[];

  /**
   * The classifier's reasoning for the verdict.
   */
  rationale: string;
}

/**
 * The minimum shape a resolved evaluation must have for the shared engine to
 * route fallbacks: only the verdict is read generically, so the pass-specific
 * identity fields live entirely in the spec's `makeResult` and `resultId`.
 */
export interface PassResult {
  /**
   * The resolved verdict, compared against the spec's negative verdict to decide
   * whether an exhaustive fallback scan is still owed.
   */
  verdict: string;
}

/**
 * An input target paired with the exact artifact sections visible to one model
 * judgment of it.
 */
export interface PassTarget<TFact> {
  /**
   * The requirement or obsolete version being judged.
   */
  fact: TFact;

  /**
   * Artifact sections supplied as evidence candidates for this judgment.
   */
  sections: ArtifactSection[];
}

/**
 * The runtime configuration shared by every bounded classification pass: the
 * model and checkpoint, the section index, and the batching, concurrency, and
 * warning knobs. Each pass's public input interface extends this with its own
 * target list.
 */
export interface BoundedPassRuntime {
  /**
   * Evaluator model used for direct structured judgments.
   */
  model: BaseChatModel;

  /**
   * Checkpoint being evaluated.
   */
  checkpointId: string;

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
   * Number of targets included in each initial model request.
   *
   * @default 15
   */
  batchSize?: number;

  /**
   * Per-attempt evaluator request deadline in milliseconds.
   *
   * @default undefined no per-attempt deadline is applied
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
   *
   * @default undefined warnings are dropped when no sink is provided
   */
  onWarning?: (warning: EvaluationWarning) => void;
}

/**
 * Everything that distinguishes one bounded classification pass from another.
 * The engine owns the batching, resilience, and exhaustive-fallback control
 * flow; the spec supplies the identity keys, the prompt and schema, the
 * evidence-free "negative" verdict, and the result constructor. The evidence
 * rule is derived, not configured: every verdict other than the negative one
 * must cite at least one section.
 */
export interface BoundedPassSpec<
  TFact,
  TOutput extends { evaluations: TItem[] } & Record<string, unknown>,
  TItem extends PassOutputItem,
  TResult extends PassResult,
> {
  /**
   * Diagnostic pass name used in warnings and model-call telemetry.
   */
  passName: DirectEvaluationPass & EvaluationWarning["pass"];

  /**
   * Capitalized human label used to prefix evaluation error messages (for
   * example `"Coverage"` yields `"Coverage evaluator returned ..."`).
   */
  label: string;

  /**
   * Name of the identity field this pass keys on, used in error messages (for
   * example `"factId"` or `"factVersionId"`).
   */
  idLabel: string;

  /**
   * Stable evaluator instructions supplied as the system message.
   */
  system: string;

  /**
   * The evidence-free verdict a target starts at and that an exhaustive fallback
   * scan tries to flip (for example coverage `"missing"`, forgetting
   * `"forgotten"`). Any other verdict must cite evidence.
   */
  negativeVerdict: string;

  /**
   * Schema every provider response for this pass must satisfy.
   */
  schema: ZodType<TOutput>;

  /**
   * Render the data-only task prompt for one request's targets.
   *
   * @param targets - Facts and their candidate sections in this request.
   *
   * @returns The task prompt string.
   */
  buildPrompt(targets: PassTarget<TFact>[]): string;

  /**
   * The identity key for one input fact (its `factId` or `factVersionId`).
   *
   * @param fact - The input fact.
   *
   * @returns The identity string used to reconcile this fact with its verdict.
   */
  targetId(fact: TFact): string;

  /**
   * The BM25 query text for one input fact (its current or obsolete statement).
   *
   * @param fact - The input fact.
   *
   * @returns The text ranked against artifact sections.
   */
  searchText(fact: TFact): string;

  /**
   * The identity key carried by one raw classifier output item.
   *
   * @param item - The raw output item.
   *
   * @returns The item's identity string, matched against `targetId`.
   */
  itemId(item: TItem): string;

  /**
   * The identity key carried by one resolved evaluation, used to key results
   * back to their fact.
   *
   * @param result - The resolved evaluation.
   *
   * @returns The result's identity string, matched against `targetId`.
   */
  resultId(result: TResult): string;

  /**
   * Build the code-owned resolved evaluation for one fact from a verdict,
   * evidence, and rationale (whether classified, repaired, or degraded).
   *
   * @param input - The fact and the verdict/evidence/rationale to record.
   *
   * @returns The resolved evaluation.
   */
  makeResult(input: {
    fact: TFact;
    verdict: string;
    evidence: string[];
    rationale: string;
  }): TResult;
}

/**
 * Any bounded pass spec, regardless of its concrete fact, output, and result
 * types. Used where the engine's helpers accept a spec generically.
 */
type AnyBoundedPassSpec<
  TFact,
  TOutput extends { evaluations: TItem[] } & Record<string, unknown>,
  TItem extends PassOutputItem,
  TResult extends PassResult,
> = BoundedPassSpec<TFact, TOutput, TItem, TResult>;

/**
 * Resolve raw classifier output into exactly one evaluation per requested fact.
 * Unknown ids, duplicate verdicts, and missing verdicts are evaluation failures
 * rather than implicit defaults.
 *
 * @param spec - The pass definition.
 * @param facts - Facts requested from the classifier.
 * @param output - Parsed classifier output.
 *
 * @returns One evaluation per fact in request order.
 *
 * @throws EvaluationError when output identity or completeness is invalid.
 */
export function resolvePass<
  TFact,
  TOutput extends { evaluations: TItem[] } & Record<string, unknown>,
  TItem extends PassOutputItem,
  TResult extends PassResult,
>(
  spec: AnyBoundedPassSpec<TFact, TOutput, TItem, TResult>,
  facts: TFact[],
  output: TOutput,
): TResult[] {
  const requested = new Set(facts.map((fact) => spec.targetId(fact)));
  const byId = new Map<string, TItem>();

  for (const item of output.evaluations) {
    const id = spec.itemId(item);

    if (!requested.has(id)) {
      throw new EvaluationError(
        `${spec.label} evaluator returned a verdict for unknown ${spec.idLabel} "${id}".`,
      );
    }

    if (byId.has(id)) {
      throw new EvaluationError(
        `${spec.label} evaluator returned more than one verdict for ${spec.idLabel} "${id}".`,
      );
    }

    byId.set(id, item);
  }

  return facts.map((fact) => {
    const item = byId.get(spec.targetId(fact));

    if (item === undefined) {
      throw new EvaluationError(
        `${spec.label} evaluator returned no verdict for ${spec.idLabel} "${spec.targetId(fact)}".`,
      );
    }

    return spec.makeResult({
      fact,
      verdict: item.verdict,
      evidence: item.evidence,
      rationale: item.rationale,
    });
  });
}

/**
 * Validate evidence citations and evidence/verdict consistency for one request.
 * A citation must name a section that was visible to the request, and every
 * verdict other than the negative one must cite at least one section.
 *
 * @param spec - The pass definition.
 * @param targets - Facts and sections supplied to the model.
 * @param output - Parsed classifier output.
 *
 * @throws EvaluationError when a citation was unavailable to the request or a
 * verdict has an invalid evidence shape.
 */
function validateOutput<
  TFact,
  TOutput extends { evaluations: TItem[] } & Record<string, unknown>,
  TItem extends PassOutputItem,
  TResult extends PassResult,
>(
  spec: AnyBoundedPassSpec<TFact, TOutput, TItem, TResult>,
  targets: PassTarget<TFact>[],
  output: TOutput,
): void {
  // Strict resolve first: this throws on unknown, duplicate, or missing ids so
  // the byId lookup below is guaranteed to find every target's item.
  resolvePass(
    spec,
    targets.map((target) => target.fact),
    output,
  );
  const allowedSectionIds = new Set(
    targets.flatMap((target) => target.sections.map((section) => section.id)),
  );
  const byId = new Map(
    output.evaluations.map((item) => [spec.itemId(item), item] as const),
  );

  for (const { fact } of targets) {
    const id = spec.targetId(fact);
    const item = byId.get(id) as TItem;

    for (const sectionId of item.evidence) {
      if (!allowedSectionIds.has(sectionId)) {
        throw new EvaluationError(
          `${spec.label} evaluator cited unavailable sectionId "${sectionId}" for ${spec.idLabel} "${id}".`,
        );
      }
    }

    if (item.verdict !== spec.negativeVerdict && item.evidence.length === 0) {
      throw new EvaluationError(
        `${spec.label} evaluator returned no evidence for ${item.verdict} ${spec.idLabel} "${id}".`,
      );
    }
  }
}

/**
 * Resolve and validate one target from a possibly imperfect batch response.
 * Other targets' malformed or extra entries cannot invalidate this item.
 *
 * @param spec - The pass definition.
 * @param target - The target being resolved.
 * @param output - Schema-valid batch response.
 * @param allowedSectionIds - Evidence identities visible anywhere in the batch.
 *
 * @returns One validated code-owned evaluation.
 *
 * @throws EvaluationError when this target is missing, duplicated, invalid by
 * evidence, or cites unavailable evidence.
 */
function resolveItem<
  TFact,
  TOutput extends { evaluations: TItem[] } & Record<string, unknown>,
  TItem extends PassOutputItem,
  TResult extends PassResult,
>(
  spec: AnyBoundedPassSpec<TFact, TOutput, TItem, TResult>,
  target: PassTarget<TFact>,
  output: TOutput,
  allowedSectionIds: Set<string>,
): TResult {
  const id = spec.targetId(target.fact);
  const matches = output.evaluations.filter((item) => spec.itemId(item) === id);

  if (matches.length !== 1) {
    throw new EvaluationError(
      `${spec.label} evaluator returned ${matches.length} verdicts for ${spec.idLabel} "${id}".`,
    );
  }

  const [item] = matches;
  const uniqueEvidence = new Set(item.evidence);

  if (uniqueEvidence.size !== item.evidence.length) {
    throw new EvaluationError(
      `${spec.label} evaluator returned duplicate evidence for ${spec.idLabel} "${id}".`,
    );
  }

  for (const sectionId of item.evidence) {
    if (!allowedSectionIds.has(sectionId)) {
      throw new EvaluationError(
        `${spec.label} evaluator cited unavailable sectionId "${sectionId}" for ${spec.idLabel} "${id}".`,
      );
    }
  }

  if (item.verdict !== spec.negativeVerdict && item.evidence.length === 0) {
    throw new EvaluationError(
      `${spec.label} evaluator returned no evidence for ${item.verdict} ${spec.idLabel} "${id}".`,
    );
  }

  return spec.makeResult({
    fact: target.fact,
    verdict: item.verdict,
    evidence: item.evidence,
    rationale: item.rationale,
  });
}

/**
 * Run one bounded request and resolve it to code-owned evaluations, applying the
 * full semantic validation before resolving.
 *
 * @param spec - The pass definition.
 * @param runtime - Model, checkpoint, and deadline configuration.
 * @param targets - Facts and excerpts included in the request.
 *
 * @returns One validated evaluation per target.
 */
async function evaluateBatch<
  TFact,
  TOutput extends { evaluations: TItem[] } & Record<string, unknown>,
  TItem extends PassOutputItem,
  TResult extends PassResult,
>(
  spec: AnyBoundedPassSpec<TFact, TOutput, TItem, TResult>,
  runtime: BoundedPassRuntime,
  targets: PassTarget<TFact>[],
): Promise<TResult[]> {
  const output = await invokeStructuredModel({
    model: runtime.model,
    pass: spec.passName,
    checkpointId: runtime.checkpointId,
    systemPrompt: spec.system,
    taskPrompt: spec.buildPrompt(targets),
    schema: spec.schema,
    validate: (parsed) => validateOutput(spec, targets, parsed),
    timeoutMs: runtime.timeoutMs,
  });

  return resolvePass(
    spec,
    targets.map((target) => target.fact),
    output,
  );
}

/**
 * Evaluate a batch without letting one malformed item discard valid neighboring
 * judgments. A whole-batch failure degrades to an empty response; invalid items
 * each receive one isolated structured request, and an item that still fails
 * becomes explicitly indeterminate with the real cause threaded into the
 * warning. The batch error is already prompt-redacted and length-bounded by
 * `invokeStructuredModel` before it reaches here.
 *
 * @param spec - The pass definition.
 * @param runtime - Model, checkpoint, deadline, and warning configuration.
 * @param targets - Facts and excerpts included in the initial batch.
 *
 * @returns One valid or indeterminate evaluation per target.
 */
async function evaluateBatchResilient<
  TFact,
  TOutput extends { evaluations: TItem[] } & Record<string, unknown>,
  TItem extends PassOutputItem,
  TResult extends PassResult,
>(
  spec: AnyBoundedPassSpec<TFact, TOutput, TItem, TResult>,
  runtime: BoundedPassRuntime,
  targets: PassTarget<TFact>[],
): Promise<TResult[]> {
  let output: TOutput;
  let batchError: unknown;

  try {
    output = await invokeStructuredModel({
      model: runtime.model,
      pass: spec.passName,
      checkpointId: runtime.checkpointId,
      systemPrompt: spec.system,
      taskPrompt: spec.buildPrompt(targets),
      schema: spec.schema,
      timeoutMs: runtime.timeoutMs,
    });
  } catch (error) {
    batchError = error;
    output = { evaluations: [] } as unknown as TOutput;
  }

  const allowedSectionIds = new Set(
    targets.flatMap((target) => target.sections.map((section) => section.id)),
  );
  const evaluations: TResult[] = [];

  for (const target of targets) {
    try {
      evaluations.push(resolveItem(spec, target, output, allowedSectionIds));
    } catch (initialError) {
      try {
        const [repaired] = await evaluateBatch(spec, runtime, [target]);
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
        runtime.onWarning?.({
          pass: spec.passName,
          itemId: spec.targetId(target.fact),
          message,
        });
        evaluations.push(
          spec.makeResult({
            fact: target.fact,
            verdict: "indeterminate",
            evidence: [],
            rationale: `Evaluator could not repair this ${spec.label.toLowerCase()} judgment: ${message}`,
          }),
        );
      }
    }
  }

  return evaluations;
}

/**
 * Exhaustively scan every untried section for one target still at the negative
 * verdict, stopping at the first section batch that flips it. The scan stays
 * strictly serial and early-breaks so it examines the minimum evidence, exactly
 * as when the fallback ran inline; only the per-target calls run concurrently.
 *
 * @param spec - The pass definition.
 * @param runtime - Model, checkpoint, deadline, and warning configuration.
 * @param target - Target whose initial verdict was the negative one.
 * @param allSections - Every artifact section available as evidence.
 * @param initial - The initial negative evaluation retained when no section
 * flips the verdict.
 *
 * @returns The first non-negative verdict found, else the initial one.
 */
async function resolveFallback<
  TFact,
  TOutput extends { evaluations: TItem[] } & Record<string, unknown>,
  TItem extends PassOutputItem,
  TResult extends PassResult,
>(
  spec: AnyBoundedPassSpec<TFact, TOutput, TItem, TResult>,
  runtime: BoundedPassRuntime,
  target: PassTarget<TFact>,
  allSections: ArtifactSection[],
  initial: TResult,
): Promise<TResult> {
  const examined = new Set(target.sections.map((section) => section.id));
  const remaining = allSections.filter((section) => !examined.has(section.id));
  let evaluation = initial;

  for (const sections of batch(remaining, FALLBACK_SECTION_BATCH_SIZE)) {
    [evaluation] = await evaluateBatchResilient(spec, runtime, [
      { fact: target.fact, sections },
    ]);

    if (evaluation.verdict !== spec.negativeVerdict) {
      break;
    }
  }

  return evaluation;
}

/**
 * Run a bounded classification pass with BM25-first evidence and an exhaustive
 * fallback before any negative verdict becomes final. This is the control flow
 * shared by the coverage and forgetting passes; the spec supplies everything
 * pass-specific.
 *
 * @param spec - The pass definition.
 * @param runtime - Model, checkpoint, and batching configuration.
 * @param facts - The input facts to classify, in the order results are returned.
 *
 * @returns One verdict per input fact in input order.
 */
export async function runBoundedPass<
  TFact,
  TOutput extends { evaluations: TItem[] } & Record<string, unknown>,
  TItem extends PassOutputItem,
  TResult extends PassResult,
>(
  spec: AnyBoundedPassSpec<TFact, TOutput, TItem, TResult>,
  runtime: BoundedPassRuntime,
  facts: TFact[],
): Promise<TResult[]> {
  if (facts.length === 0) {
    return [];
  }

  const topK = runtime.topK ?? DEFAULT_TOP_K;
  const batchSize = runtime.batchSize ?? DEFAULT_TARGET_BATCH_SIZE;
  const limit = runtime.limit ?? createLimiter(DEFAULT_PASS_CONCURRENCY);
  assertPositiveInteger(topK, `${spec.label} topK`);
  assertPositiveInteger(batchSize, `${spec.label} batchSize`);

  const allSections = runtime.index.sections();

  if (allSections.length === 0) {
    return facts.map((fact) =>
      spec.makeResult({
        fact,
        verdict: spec.negativeVerdict,
        evidence: [],
        rationale: NO_SECTIONS_RATIONALE,
      }),
    );
  }

  const initialTargets = facts.map((fact): PassTarget<TFact> => ({
    fact,
    sections: runtime.index
      .search(spec.searchText(fact), topK)
      .map((ranked) => ranked.section),
  }));
  const resultById = new Map<string, TResult>();

  const batchResults = await mapWithLimit(
    batch(initialTargets, batchSize),
    limit,
    (targets) => evaluateBatchResilient(spec, runtime, targets),
  );

  for (const evaluations of batchResults) {
    for (const evaluation of evaluations) {
      resultById.set(spec.resultId(evaluation), evaluation);
    }
  }

  // Every target still at the negative verdict gets an independent exhaustive
  // scan; the targets are independent and each writes only its own result, so
  // they run concurrently while each scan's inner section walk stays serial.
  const negativeTargets = initialTargets.filter(
    (target) =>
      (resultById.get(spec.targetId(target.fact)) as TResult).verdict ===
      spec.negativeVerdict,
  );
  const fallbackResults = await mapWithLimit(negativeTargets, limit, (target) =>
    resolveFallback(
      spec,
      runtime,
      target,
      allSections,
      resultById.get(spec.targetId(target.fact)) as TResult,
    ),
  );

  for (const evaluation of fallbackResults) {
    resultById.set(spec.resultId(evaluation), evaluation);
  }

  return facts.map((fact) => resultById.get(spec.targetId(fact)) as TResult);
}
