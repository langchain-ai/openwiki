import type { CheckpointResult, LedgerScore } from "../core/types.js";

/**
 * Compute the run-level LEDGER score from auditable checkpoint outcomes.
 *
 * Claim health is opportunity-weighted across the trace: every supported
 * current claim contributes to the numerator and every current claim—including
 * stale, invented, and unverified claims—contributes to the denominator.
 * Forgetting is likewise opportunity-weighted across determinate obsolete-fact
 * checks. Because the watchlist is sticky, a lingering fact is penalized again
 * at every checkpoint until it is forgotten.
 *
 * The final score is the harmonic mean of claim health and forgetting so a weak
 * dimension cannot be hidden by a strong one. If a trace contains no determinate
 * forgetting opportunity, claim health is the only observed dimension and is
 * therefore the score.
 */
export function computeLedgerScore(
  checkpoints: CheckpointResult[],
): LedgerScore {
  const supported = checkpoints.reduce(
    (sum, checkpoint) => sum + checkpoint.claims.supported,
    0,
  );
  const currentClaims = checkpoints.reduce(
    (sum, checkpoint) => sum + checkpoint.claims.total,
    0,
  );
  const claimHealth = currentClaims === 0 ? 0 : supported / currentClaims;
  const forgettingEvaluations = checkpoints.flatMap(
    (checkpoint) => checkpoint.evaluations?.forgettingEvaluations ?? [],
  );
  const determinateForgetting = forgettingEvaluations.filter(
    (evaluation) => evaluation.verdict !== "indeterminate",
  );
  const forgetting =
    determinateForgetting.length === 0
      ? undefined
      : determinateForgetting.filter(
          (evaluation) => evaluation.verdict === "forgotten",
        ).length / determinateForgetting.length;
  const value =
    forgetting === undefined
      ? claimHealth
      : claimHealth === 0 || forgetting === 0
        ? 0
        : (2 * claimHealth * forgetting) / (claimHealth + forgetting);

  return { value, claimHealth, forgetting };
}
