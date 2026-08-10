import { z } from "zod";

/**
 * Coverage verdict for one fact.
 */
export const factVerdictSchema = z.enum([
  "correct",
  "partial",
  "missing",
  "contradicted",
]);

/**
 * The coverage pass's raw output: one verdict per fact the classifier received.
 * Evidence contains supplied artifact section IDs and defaults to an empty
 * array so an omitted field is not a schema error.
 */
export const coverageOutputSchema = z.object({
  evaluations: z.array(
    z.object({
      factId: z.string(),
      verdict: factVerdictSchema,
      evidence: z.array(z.string()).default([]),
      rationale: z.string(),
    }),
  ),
});

/**
 * The forgetting pass's raw output: one verdict per obsolete fact version the
 * classifier received. Evidence contains supplied artifact section IDs. Results
 * are keyed by `factVersionId`, distinguishing a lingering earlier version from
 * current truth.
 */
export const forgettingOutputSchema = z.object({
  evaluations: z.array(
    z.object({
      factVersionId: z.string(),
      verdict: z.enum(["forgotten", "lingering"]),
      evidence: z.array(z.string()).default([]),
      rationale: z.string(),
    }),
  ),
});

/**
 * Raw accountable text-unit classification and assertion-extraction output.
 */
export const assertionExtractionOutputSchema = z.object({
  units: z.array(
    z.object({
      unitId: z.string(),
      classification: z.enum([
        "factual",
        "mixed",
        "navigation",
        "meta-artifact",
        "opinion",
        "instruction",
        "no-claim",
      ]),
      assertions: z.array(
        z.object({
          statement: z.string().trim().min(1),
          tense: z.enum(["current", "historical"]),
        }),
      ),
      rationale: z.string().trim().min(1),
    }),
  ),
});

/**
 * Enforce the cross-field invariant shared by both precision passes:
 * `formerlyTrue` must be present exactly when the verdict is `contradicted`.
 *
 * This is attached to the strict single-item schemas used by isolated repair
 * calls. The batch schemas deliberately omit it and defer the identical check to
 * per-item resolution (see `resolveLedgerItem` / `resolveJudgments`), so one
 * malformed element degrades to a fallback verdict instead of failing the whole
 * batch parse.
 *
 * @param evaluation - One decoded precision evaluation element.
 * @param context - The Zod refinement context used to report violations.
 *
 * @returns Nothing; a violation is reported through `context.addIssue`.
 */
function refineFormerlyTrue(
  evaluation: { verdict: string; formerlyTrue?: boolean },
  context: z.RefinementCtx,
): void {
  if (
    (evaluation.verdict === "contradicted") !==
    (evaluation.formerlyTrue !== undefined)
  ) {
    context.addIssue({
      code: "custom",
      path: ["formerlyTrue"],
      message: "formerlyTrue is required exactly when verdict is contradicted",
    });
  }
}

/**
 * One raw required-ledger accounting evaluation, before the cross-field
 * invariant is applied.
 */
const precisionLedgerEvaluationSchema = z.object({
  assertionId: z.string(),
  verdict: z.enum(["supported", "contradicted", "unaccounted"]),
  factVersionIds: z.array(z.string()).default([]),
  formerlyTrue: z.boolean().optional(),
  rationale: z.string().trim().min(1),
});

/**
 * One raw refutation evaluation for a current, off-ledger claim, before the
 * cross-field invariant is applied.
 */
const precisionJudgmentEvaluationSchema = z.object({
  assertionId: z.string(),
  verdict: z.enum(["contradicted", "not-refuted"]),
  evidenceIds: z.array(z.string()).default([]),
  formerlyTrue: z.boolean().optional(),
  rationale: z.string().trim().min(1),
});

/**
 * Strict required-ledger accounting output for a single isolated repair, where
 * the cross-field invariant is enforced at parse time so the model gets a retry
 * before the element is degraded.
 */
export const precisionLedgerOutputSchema = z.object({
  evaluations: z.array(
    precisionLedgerEvaluationSchema.superRefine(refineFormerlyTrue),
  ),
});

/**
 * Lenient required-ledger accounting output for a batch. Parsing does not reject
 * the whole array when one element violates the cross-field invariant; that rule
 * is enforced per element by `resolveLedgerItem`, so a single bad element can
 * degrade to `unaccounted` while its neighbors survive.
 */
export const precisionLedgerBatchOutputSchema = z.object({
  evaluations: z.array(precisionLedgerEvaluationSchema),
});

/**
 * Strict refutation output for a single isolated repair, where the cross-field
 * invariant is enforced at parse time so the model gets a retry before the
 * element is degraded.
 */
export const precisionJudgmentOutputSchema = z.object({
  evaluations: z.array(
    precisionJudgmentEvaluationSchema.superRefine(refineFormerlyTrue),
  ),
});

/**
 * Lenient refutation output for a batch. Parsing does not reject the whole array
 * when one element violates the cross-field invariant; that rule is enforced per
 * element by `resolveJudgments`, so a single bad element can degrade to
 * `unverified` while its neighbors survive.
 */
export const precisionJudgmentBatchOutputSchema = z.object({
  evaluations: z.array(precisionJudgmentEvaluationSchema),
});

/**
 * Inferred type of the coverage pass output.
 */
export type CoverageOutput = z.infer<typeof coverageOutputSchema>;

/**
 * Inferred type of the forgetting pass output.
 */
export type ForgettingOutput = z.infer<typeof forgettingOutputSchema>;

/**
 * Inferred type of assertion-extraction output.
 */
export type AssertionExtractionOutput = z.infer<
  typeof assertionExtractionOutputSchema
>;

/**
 * Inferred type of required-ledger accounting output.
 */
export type PrecisionLedgerOutput = z.infer<typeof precisionLedgerOutputSchema>;

/**
 * Inferred type of precision-judgment output.
 */
export type PrecisionJudgmentOutput = z.infer<
  typeof precisionJudgmentOutputSchema
>;
