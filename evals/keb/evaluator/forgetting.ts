import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { EvaluationError } from "../core/errors.js";
import { runEvaluatorPass } from "./evaluator.js";
import { FORGETTING_SYSTEM, forgettingPrompt } from "./prompts.js";
import { forgettingOutputSchema } from "./schemas.js";
import type { ForgettingOutput } from "./schemas.js";
import type {
  ForgettingEvaluation,
  ObsoleteFactTarget,
} from "../core/types.js";

/**
 * Resolve raw forgetting output into exactly one evaluation per requested
 * obsolete version. Unknown, duplicate, and missing verdicts are all evaluation
 * failures: the forgetting contract is one verdict per obsolete fact version,
 * never a silent default to forgotten.
 *
 * @param obsoleteFacts - The obsolete fact versions that were requested.
 * @param output - The agent's raw forgetting output.
 *
 * @returns One evaluation per obsolete version, in the requested order.
 *
 * @throws EvaluationError when a version is unknown, duplicated, or missing.
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
 * Run the forgetting pass and resolve it against the obsolete targets. The
 * completeness check runs inside the pass so an incomplete generation is retried
 * once before it becomes fatal.
 *
 * @param model - The evaluator model.
 * @param workspaceDir - The evaluation workspace directory.
 * @param obsoleteFacts - The obsolete fact versions that should no longer appear.
 *
 * @returns One forgetting verdict per obsolete version.
 */
export async function runForgettingPass(
  model: BaseChatModel,
  workspaceDir: string,
  obsoleteFacts: ObsoleteFactTarget[],
): Promise<ForgettingEvaluation[]> {
  if (obsoleteFacts.length === 0) {
    return [];
  }

  const output = await runEvaluatorPass({
    model,
    workspaceDir,
    systemPrompt: FORGETTING_SYSTEM,
    taskPrompt: forgettingPrompt(obsoleteFacts),
    schema: forgettingOutputSchema,
    validate: (parsed) => {
      resolveForgetting(obsoleteFacts, parsed);
    },
  });

  return resolveForgetting(obsoleteFacts, output);
}
