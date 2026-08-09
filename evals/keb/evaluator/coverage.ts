import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { EvaluationError } from "../core/errors.js";
import { runEvaluatorPass } from "./evaluator.js";
import {
  COVERAGE_SYSTEM,
  PRECISION_SYSTEM,
  coveragePrompt,
  precisionPrompt,
} from "./prompts.js";
import { coverageOutputSchema, precisionOutputSchema } from "./schemas.js";
import type { CoverageOutput } from "./schemas.js";
import type {
  ActiveTruthFact,
  FactEvaluation,
  PrecisionAssertionEvaluation,
} from "../core/types.js";

/**
 * Resolve raw coverage output into exactly one evaluation per requested fact.
 * Unknown fact ids, duplicate verdicts, and missing verdicts are all evaluation
 * failures: the coverage contract is one verdict per active fact, never a
 * silent default. The resulting evaluations carry the stable `factVersionId`
 * from the ledger so downstream maintenance scoring can reason about versions.
 *
 * @param activeFacts - The facts that were requested.
 * @param output - The agent's raw coverage output.
 *
 * @returns One evaluation per active fact, in the requested order.
 *
 * @throws EvaluationError when a fact id is unknown, duplicated, or missing.
 */
export function resolveCoverage(
  activeFacts: ActiveTruthFact[],
  output: CoverageOutput,
): FactEvaluation[] {
  const requested = new Set(activeFacts.map((fact) => fact.factId));
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

  return activeFacts.map((fact) => {
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
 * Run the coverage pass and resolve it against the active facts. The
 * completeness check runs inside the pass so an incomplete generation is retried
 * once before it becomes fatal.
 *
 * @param model - The evaluator model.
 * @param workspaceDir - The evaluation workspace directory.
 * @param activeFacts - The facts true at this checkpoint.
 *
 * @returns One coverage verdict per active fact.
 */
export async function runCoveragePass(
  model: BaseChatModel,
  workspaceDir: string,
  activeFacts: ActiveTruthFact[],
): Promise<FactEvaluation[]> {
  if (activeFacts.length === 0) {
    return [];
  }

  const output = await runEvaluatorPass({
    model,
    workspaceDir,
    systemPrompt: COVERAGE_SYSTEM,
    taskPrompt: coveragePrompt(activeFacts),
    schema: coverageOutputSchema,
    validate: (parsed) => {
      resolveCoverage(activeFacts, parsed);
    },
  });

  return resolveCoverage(activeFacts, output);
}

/**
 * Run the precision pass over every unique material assertion in the wiki. No
 * completeness check is possible here because the set of assertions is not known
 * in advance; the pass extracts and judges all of them against the ledger, and
 * its output is the precision result in full.
 *
 * @param model - The evaluator model.
 * @param workspaceDir - The evaluation workspace directory.
 *
 * @returns The precision verdicts, one per unique material assertion.
 */
export async function runPrecisionPass(
  model: BaseChatModel,
  workspaceDir: string,
): Promise<PrecisionAssertionEvaluation[]> {
  const output = await runEvaluatorPass({
    model,
    workspaceDir,
    systemPrompt: PRECISION_SYSTEM,
    taskPrompt: precisionPrompt(),
    schema: precisionOutputSchema,
  });

  return output.evaluations.map((evaluation) => ({
    assertion: evaluation.assertion,
    location: evaluation.location,
    verdict: evaluation.verdict,
    supportingFactIds: evaluation.supportingFactIds,
    rationale: evaluation.rationale,
  }));
}
