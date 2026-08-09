import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { createModel } from "../../../src/agent/index.js";
import {
  PROVIDER_CONFIGS,
  type OpenWikiProvider,
} from "../../../src/config/constants.js";
import { runCoveragePass, runPrecisionPass } from "./coverage.js";
import { sectionArtifact } from "./documents.js";
import { EvaluationError } from "../core/errors.js";
import { runForgettingPass } from "./forgetting.js";
import { PROMPT_VERSION } from "./prompts.js";
import { SectionBm25Index } from "./retrieval.js";
import type {
  CheckpointEvaluation,
  EvaluationBackend,
  EvaluationInput,
} from "../core/types.js";

/**
 * Narrow a raw provider string to a known OpenWiki provider, so a typo fails
 * fast with a clear message rather than deep inside model construction.
 *
 * @param provider - The raw provider id from config.
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
 * Options for the agent-backed evaluation backend.
 */
export interface AgentEvaluationBackendOptions {
  /**
   * Provider id for the evaluator model (typically the same provider as the
   * system under test).
   */
  provider: string;

  /**
   * Concrete model id for the evaluator.
   */
  modelId: string;
}

/**
 * Evaluator model surface carrying the common sampling-temperature field used
 * by the provider wrappers returned from OpenWiki's model factory.
 */
interface TemperatureConfigurableModel extends BaseChatModel {
  /**
   * Sampling temperature applied to evaluator requests.
   */
  temperature?: number;
}

/**
 * Transitional evaluation backend. Coverage and forgetting use bounded direct
 * model calls, while precision temporarily retains its sandboxed agent until
 * Phase 4 replaces it.
 */
export class AgentEvaluationBackend implements EvaluationBackend {
  readonly version = PROMPT_VERSION;

  private readonly model: BaseChatModel;

  constructor(options: AgentEvaluationBackendOptions) {
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
   * Materialize the temporary workspace still required by legacy precision,
   * then run coverage, forgetting, and precision sequentially. Coverage and
   * forgetting consume deterministic sections directly from the captured
   * artifact; precision reads the copied artifact and ledger through its legacy
   * sandbox. The workspace is always removed in `finally`.
   *
   * @param input - The artifact, active facts, and obsolete fact versions.
   *
   * @returns The coverage, forgetting, and precision evaluations.
   */
  async evaluate(input: EvaluationInput): Promise<CheckpointEvaluation> {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "keb-eval-"));

    try {
      await cp(
        input.artifact.snapshotDir,
        path.join(workspaceDir, "artifact"),
        {
          recursive: true,
        },
      );
      await writeFile(
        path.join(workspaceDir, "truth-ledger.json"),
        `${JSON.stringify({ activeFacts: input.activeFacts }, null, 2)}\n`,
        "utf8",
      );

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
      const precisionEvaluations = await runPrecisionPass(
        this.model,
        workspaceDir,
      );

      return { factEvaluations, forgettingEvaluations, precisionEvaluations };
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }
}
