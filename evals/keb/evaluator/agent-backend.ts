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
import { EvaluationError } from "../core/errors.js";
import { runForgettingPass } from "./forgetting.js";
import { PROMPT_VERSION } from "./prompts.js";
import type {
  CheckpointEvaluation,
  EvaluationBackend,
  EvaluationInput,
} from "../core/types.js";

/**
 * Number of provider-level retries the evaluator model uses on transient errors.
 */
const EVALUATOR_RETRY_ATTEMPTS = 2;

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
 * An `EvaluationBackend` that scores an artifact with three sandboxed deepagents
 * passes. This is the real evaluator; the fake in the runner test satisfies the
 * same interface.
 */
export class AgentEvaluationBackend implements EvaluationBackend {
  readonly version = PROMPT_VERSION;

  private readonly model: BaseChatModel;

  constructor(options: AgentEvaluationBackendOptions) {
    this.model = createModel(
      asProvider(options.provider),
      options.modelId,
      EVALUATOR_RETRY_ATTEMPTS,
    ) as BaseChatModel;
  }

  /**
   * Materialize a per-checkpoint evaluation workspace, run the three passes
   * against it concurrently, and dispose of the workspace. The workspace holds
   * the artifact snapshot under `artifact/` and the active ledger as
   * `truth-ledger.json`; only `artifact/` is system output. It is created with
   * `mkdtemp` under the OS temp directory and removed in a `finally`, so a failed
   * pass never leaks it.
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

      const [factEvaluations, precisionEvaluations, forgettingEvaluations] =
        await Promise.all([
          runCoveragePass(this.model, workspaceDir, input.activeFacts),
          runPrecisionPass(this.model, workspaceDir),
          runForgettingPass(this.model, workspaceDir, input.obsoleteFacts),
        ]);

      return { factEvaluations, forgettingEvaluations, precisionEvaluations };
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }
}
