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
  EvaluationWarning,
} from "../core/types.js";
import { runCoveragePass } from "./coverage.js";
import { sectionArtifact } from "./documents.js";
import { runForgettingPass } from "./forgetting.js";
import { runPrecisionPass } from "./precision.js";
import type { PrecisionAssertionInventory } from "./precision.js";
import { SectionBm25Index } from "./retrieval.js";

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
   * Optional durable audit sink invoked before precision judgment.
   */
  onAssertionInventory?: (
    inventory: PrecisionAssertionInventory,
  ) => void | Promise<void>;
}

/**
 * Runs the complete bounded KEB evaluation pipeline with direct model calls.
 */
export class ModelEvaluationBackend implements EvaluationBackend {
  private readonly model: BaseChatModel;

  private readonly timeoutMs: number | undefined;

  private readonly onAssertionInventory:
    | ((inventory: PrecisionAssertionInventory) => void | Promise<void>)
    | undefined;

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
   * Run coverage, forgetting, and precision sequentially over one immutable
   * artifact. Coverage and forgetting reuse a single deterministic BM25 index.
   *
   * @param input - Artifact documents and their active and obsolete facts.
   *
   * @returns The three evaluation result sets for the checkpoint.
   */
  async evaluate(input: EvaluationInput): Promise<CheckpointEvaluation> {
    const sections = sectionArtifact(input.artifact);
    const index = new SectionBm25Index(sections);
    const warnings: EvaluationWarning[] = [];

    /**
     * Retain an item-level evaluator failure without aborting the checkpoint.
     *
     * @param warning - The repair failure to preserve for audit.
     */
    const onWarning = (warning: EvaluationWarning): void => {
      warnings.push(warning);
    };
    const factEvaluations = await runCoveragePass({
      model: this.model,
      checkpointId: input.artifact.checkpointId,
      activeFacts: input.activeFacts,
      index,
      timeoutMs: this.timeoutMs,
      onWarning,
    });
    const forgettingEvaluations = await runForgettingPass({
      model: this.model,
      checkpointId: input.artifact.checkpointId,
      obsoleteFacts: input.obsoleteFacts,
      index,
      timeoutMs: this.timeoutMs,
      onWarning,
    });
    const precisionEvaluations = await runPrecisionPass({
      model: this.model,
      checkpointId: input.artifact.checkpointId,
      sections,
      activeFacts: input.activeFacts,
      evidence: input.evidence,
      timeoutMs: this.timeoutMs,
      onInventory: this.onAssertionInventory,
      onWarning,
    });

    return {
      factEvaluations,
      forgettingEvaluations,
      precisionEvaluations,
      warnings,
    };
  }
}
