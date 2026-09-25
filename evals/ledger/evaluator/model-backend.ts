import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { createModel } from "../../../src/agent/index.js";
import {
  PROVIDER_CONFIGS,
  type OpenWikiProvider,
} from "../../../src/config/constants.js";
import { EvaluationError } from "../core/errors.js";
import type {
  CheckpointEvaluation,
  EvaluationBackend,
  EvaluationInput,
  EvaluationProgressObserver,
  EvaluationWarning,
} from "../core/types.js";
import { sectionArtifact } from "./documents.js";
import { runForgettingPass } from "./forgetting.js";
import { createLimiter } from "./pass-utils.js";
import { runPrecisionPass } from "./precision.js";
import type {
  PrecisionAssertionInventory,
  PrecisionVerdictCache,
} from "./precision.js";
import { SectionBm25Index } from "./retrieval.js";

/**
 * Total in-flight evaluator model calls allowed across the two concurrent
 * passes for one checkpoint.
 *
 * The passes share one limiter, so this bounds every batch call together rather
 * than per pass: claim grounding can borrow the whole budget when forgetting is
 * idle. Kept conservative because
 * provider retries are disabled (constructor passes 0), so a 429 burst degrades
 * verdicts rather than being absorbed.
 */
const EVALUATOR_CONCURRENCY = 6;

/**
 * Narrow a raw provider string to a known OpenWiki provider.
 *
 * @param provider - Raw provider id from configuration.
 *
 * @returns The validated provider.
 *
 * @throws EvaluationError when the provider is not recognized.
 */
function asProvider(provider: string): OpenWikiProvider {
  if (!(provider in PROVIDER_CONFIGS)) {
    throw new EvaluationError(`Unknown evaluator provider "${provider}".`);
  }

  return provider as OpenWikiProvider;
}

/**
 * Options for the direct-model evaluation backend.
 */
export interface ModelEvaluationBackendOptions {
  /**
   * Provider id for the evaluator model.
   */
  provider: string;

  /**
   * Concrete model id for the evaluator.
   */
  modelId: string;

  /**
   * Per-attempt evaluator request deadline in milliseconds.
   *
   * @default 300000
   */
  timeoutMs?: number;

  /**
   * Optional durable audit sink invoked before precision judgment and finalized
   * after cache resolution and any historical follow-up.
   *
   * @default undefined the assertion inventory is not surfaced when absent
   */
  onAssertionInventory?: (
    inventory: PrecisionAssertionInventory,
  ) => void | Promise<void>;
}

/**
 * Runs the complete bounded LEDGER evaluation pipeline with direct model calls.
 *
 * Forgetting and claim grounding are independent per checkpoint, so they run
 * concurrently, and within each pass the batch loops also run concurrently
 * under one shared limiter (`EVALUATOR_CONCURRENCY`). Peak in-flight requests
 * stay globally bounded regardless of how deep any single pass's batch queue is;
 * precision's extraction still completes before its judgment. This turns
 * per-checkpoint latency from the serial sum of every batch into the queue depth
 * divided by the shared budget.
 *
 * The instance also carries a cross-checkpoint precision verdict cache, so a
 * claim whose text and grounding evidence are unchanged from an earlier
 * checkpoint reuses its verdict instead of being re-judged, cutting precision's
 * otherwise super-linear re-judging over a multi-checkpoint run.
 */
export class ModelEvaluationBackend implements EvaluationBackend {
  private readonly model: BaseChatModel;

  private readonly timeoutMs: number | undefined;

  private readonly onAssertionInventory:
    | ((inventory: PrecisionAssertionInventory) => void | Promise<void>)
    | undefined;

  /**
   * Cross-checkpoint precision verdict cache. The backend instance lives for a
   * whole run, so a claim whose text and grounding evidence are unchanged from
   * an earlier checkpoint reuses that verdict instead of being re-judged.
   */
  private readonly precisionVerdictCache: PrecisionVerdictCache = new Map();

  constructor(options: ModelEvaluationBackendOptions) {
    const model = createModel(
      asProvider(options.provider),
      options.modelId,
      // Evaluator orchestration owns its retry ceiling. Disabling nested
      // provider retries keeps the total request count bounded and observable.
      0,
    );

    this.model = model;
    this.timeoutMs = options.timeoutMs;
    this.onAssertionInventory = options.onAssertionInventory;
  }

  /**
   * Run forgetting and claim evaluation concurrently over one immutable
   * artifact. The two passes only read shared inputs, so the concurrency is race-free;
   * warnings are collected in completion order rather than pass order.
   *
   * @param input - Artifact documents and their active and obsolete facts.
   *
   * @returns The three evaluation result sets for the checkpoint.
   */
  async evaluate(
    input: EvaluationInput,
    observer?: EvaluationProgressObserver,
  ): Promise<CheckpointEvaluation> {
    const sections = sectionArtifact(input.artifact);
    const index = new SectionBm25Index(sections);
    const warnings: EvaluationWarning[] = [];
    let currentClaimCount: number | undefined;
    let groundingCompleted = 0;
    let groundingTotal = 0;
    let forgettingCompleted = 0;
    let lastReportedEvaluationProgress: string | undefined;

    /** Report aggregate post-extraction progress once the claim total is known. */
    const reportEvaluationProgress = (): void => {
      if (currentClaimCount === undefined) {
        return;
      }

      const completed = groundingCompleted + forgettingCompleted;
      const total = groundingTotal + input.obsoleteFacts.length;
      const signature = `${currentClaimCount}:${completed}:${total}`;
      if (signature === lastReportedEvaluationProgress) {
        return;
      }
      lastReportedEvaluationProgress = signature;
      observer?.onClaimEvaluationProgress?.(
        currentClaimCount,
        completed,
        total,
      );
    };

    /**
     * Retain an item-level evaluator failure without aborting the checkpoint.
     *
     * @param warning - The repair failure to preserve for audit.
     */
    const onWarning = (warning: EvaluationWarning): void => {
      warnings.push(warning);
    };
    // One limiter shared by all three passes bounds their combined in-flight
    // model calls. Without it each pass would parallelize its own batches
    // independently and the checkpoint could issue three full budgets at once.
    const limit = createLimiter(EVALUATOR_CONCURRENCY);
    const [forgettingEvaluations, precisionEvaluations] = await Promise.all([
      runForgettingPass({
        model: this.model,
        checkpointId: input.artifact.checkpointId,
        obsoleteFacts: input.obsoleteFacts,
        index,
        timeoutMs: this.timeoutMs,
        limit,
        onProgress: (completed) => {
          forgettingCompleted = completed;
          reportEvaluationProgress();
        },
        onWarning,
      }),
      runPrecisionPass({
        model: this.model,
        checkpointId: input.artifact.checkpointId,
        sections,
        evidence: input.evidence,
        evidenceMap: input.evidenceMap,
        timeoutMs: this.timeoutMs,
        limit,
        verdictCache: this.precisionVerdictCache,
        onExtractionProgress: (completed, total) =>
          observer?.onClaimExtractionProgress?.(completed, total),
        onInventory: async (inventory) => {
          currentClaimCount = inventory.candidates.filter(
            (candidate) =>
              candidate.disposition === "kept" && candidate.tense === "current",
          ).length;
          groundingTotal = inventory.keptAssertionCount;
          reportEvaluationProgress();
          await this.onAssertionInventory?.(inventory);
        },
        onGroundingProgress: (completed) => {
          groundingCompleted = completed;
          reportEvaluationProgress();
        },
        onWarning,
      }),
    ]);

    return {
      forgettingEvaluations,
      precisionEvaluations,
      warnings,
    };
  }
}
