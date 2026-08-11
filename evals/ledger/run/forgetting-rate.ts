import type { LedgerRunResult } from "../core/types.js";

/**
 * A checkpoint's fact-forgetting evaluations, as carried on a run result. Derived
 * by indexed access so this helper stays coupled to the result shape rather than
 * a separately imported element type.
 */
type ForgettingEvaluations = NonNullable<
  LedgerRunResult["checkpoints"][number]["evaluations"]
>["forgettingEvaluations"];

/**
 * A checkpoint's forgetting outcome over the obsolete versions actually judged
 * there: the fraction forgotten plus the counts behind it.
 */
export interface ForgettingRate {
  /**
   * Fraction of judged obsolete versions that were forgotten, in [0, 1].
   */
  rate: number;

  /**
   * Number of judged versions that were forgotten.
   */
  forgotten: number;

  /**
   * Number of obsolete versions judged, that is with a determinate verdict.
   */
  judged: number;
}

/**
 * Compute a checkpoint's forgetting rate from its fact-forgetting evaluations,
 * counting only versions with a determinate verdict. This is the single home for
 * the rate the report table and the run summary both render.
 *
 * @param evaluations - The checkpoint's fact-forgetting evaluations, or undefined when the checkpoint carries no evaluation detail.
 *
 * @returns The rate and its counts, or undefined when nothing obsolete was judged.
 */
export function forgettingRate(
  evaluations: ForgettingEvaluations | undefined,
): ForgettingRate | undefined {
  if (evaluations === undefined) {
    return undefined;
  }

  const judged = evaluations.filter(
    (evaluation) => evaluation.verdict !== "indeterminate",
  );
  if (judged.length === 0) {
    return undefined;
  }

  const forgotten = judged.filter(
    (evaluation) => evaluation.verdict === "forgotten",
  ).length;

  return { rate: forgotten / judged.length, forgotten, judged: judged.length };
}
