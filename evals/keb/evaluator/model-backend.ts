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
} from "../core/types.js";
import { runCoveragePass } from "./coverage.js";
import { sectionArtifact } from "./documents.js";
import { runForgettingPass } from "./forgetting.js";
import { runPrecisionPass } from "./precision.js";
import { PROMPT_VERSION } from "./prompts.js";
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
}

/**
 * Evaluator model surface carrying the common sampling-temperature field.
 */
interface TemperatureConfigurableModel extends BaseChatModel {
  /**
   * Sampling temperature applied to evaluator requests.
   */
  temperature?: number;
}

/**
 * Runs the complete bounded KEB evaluation pipeline with direct model calls.
 */
export class ModelEvaluationBackend implements EvaluationBackend {
  readonly version = PROMPT_VERSION;

  private readonly model: BaseChatModel;

  constructor(options: ModelEvaluationBackendOptions) {
    const model = createModel(
      asProvider(options.provider),
      options.modelId,
      // Evaluator orchestration owns its retry ceiling. Disabling nested
      // provider retries keeps the total request count bounded and observable.
      0,
    ) as TemperatureConfigurableModel;

    model.temperature = 0;
    this.model = model;
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
    const factEvaluations = await runCoveragePass({
      model: this.model,
      checkpointId: input.artifact.checkpointId,
      activeFacts: input.activeFacts,
      index,
    });
    const forgettingEvaluations = await runForgettingPass({
      model: this.model,
      checkpointId: input.artifact.checkpointId,
      obsoleteFacts: input.obsoleteFacts,
      index,
    });
    const precisionEvaluations = await runPrecisionPass({
      model: this.model,
      checkpointId: input.artifact.checkpointId,
      sections,
      activeFacts: input.activeFacts,
    });

    return { factEvaluations, forgettingEvaluations, precisionEvaluations };
  }
}
