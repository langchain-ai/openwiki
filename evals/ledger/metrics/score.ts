import type { CheckpointResult, LedgerScore } from "../core/types.js";

/**
 * Compute the run-level LEDGER score from auditable checkpoint outcomes.
 *
 * The score is opportunity-weighted claim health across the trace: every supported
 * current claim contributes to the numerator and every current claim—including
 * stale, invented, and unverified claims—contributes to the denominator.
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

  return { value: claimHealth, claimHealth };
}
