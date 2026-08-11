import type {
  ForgettingEvaluation,
  ObsoleteFactTarget,
} from "../core/types.js";
import {
  runBoundedPass,
  resolvePass,
  type BoundedPassRuntime,
  type BoundedPassSpec,
} from "./bounded-pass.js";
import { toExcerpt } from "./pass-utils.js";
import { FORGETTING_SYSTEM, forgettingPrompt } from "./prompts.js";
import { forgettingOutputSchema } from "./schemas.js";
import type { ForgettingOutput } from "./schemas.js";

/**
 * Inputs for the bounded forgetting pass: the runtime shared by every pass plus
 * the obsolete versions this pass watches.
 */
export interface ForgettingPassInput extends BoundedPassRuntime {
  /**
   * Obsolete fact versions that must no longer be asserted as current truth.
   */
  obsoleteFacts: ObsoleteFactTarget[];
}

/**
 * The forgetting pass definition. Forgetting keys on `factVersionId`, ranks
 * sections by a version's obsolete statement, and starts every version at the
 * evidence-free `forgotten` verdict; a `lingering` verdict must cite a section.
 */
const forgettingSpec: BoundedPassSpec<
  ObsoleteFactTarget,
  ForgettingOutput,
  ForgettingOutput["evaluations"][number],
  ForgettingEvaluation
> = {
  passName: "forgetting",
  label: "Forgetting",
  idLabel: "factVersionId",
  system: FORGETTING_SYSTEM,
  negativeVerdict: "forgotten",
  schema: forgettingOutputSchema,
  buildPrompt: (targets) =>
    forgettingPrompt(
      targets.map(({ fact, sections }) => ({
        factVersionId: fact.factVersionId,
        obsoleteStatement: fact.obsoleteStatement,
        excerpts: sections.map(toExcerpt),
      })),
    ),
  targetId: (fact) => fact.factVersionId,
  searchText: (fact) => fact.obsoleteStatement,
  itemId: (item) => item.factVersionId,
  resultId: (result) => result.factVersionId,
  makeResult: ({ fact, verdict, evidence, rationale }) => ({
    factId: fact.factId,
    factVersionId: fact.factVersionId,
    verdict: verdict as ForgettingEvaluation["verdict"],
    evidence,
    rationale,
  }),
};

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
  return resolvePass(forgettingSpec, obsoleteFacts, output);
}

/**
 * Run bounded obsolete-knowledge classification with BM25-first evidence and
 * exhaustive fallback before any `forgotten` verdict becomes final.
 *
 * @param input - Forgetting pass configuration.
 *
 * @returns One forgetting verdict per obsolete version in input order.
 */
export function runForgettingPass(
  input: ForgettingPassInput,
): Promise<ForgettingEvaluation[]> {
  return runBoundedPass(forgettingSpec, input, input.obsoleteFacts);
}
