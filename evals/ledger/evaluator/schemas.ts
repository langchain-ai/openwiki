import { z } from "zod";

/**
 * The forgetting pass's raw output: one verdict per obsolete fact version the
 * classifier received. Evidence contains supplied artifact section IDs. Results
 * are keyed by `factVersionId`, distinguishing a lingering earlier version from
 * current truth.
 *
 * Fields are ordered reasoning-first: the classifier writes its `rationale` and
 * cites `evidence` before committing a `verdict`, so the label is conditioned on
 * the completed reasoning rather than fixed before it.
 */
export const forgettingOutputSchema = z.object({
  /**
   * One verdict per obsolete fact version the classifier received. Defaults to
   * an empty array so a degenerate tool-call payload (Anthropic structured
   * output is forced tool use, and the model can return `{}`) parses to an empty
   * batch and degrades per item rather than crashing the pass at the schema
   * boundary. Every requested target is still reconciled by
   * `resolveForgettingItem`, so a missing item is repaired or degraded, never
   * silently dropped.
   *
   * @default [] when the model omits the field entirely
   */
  evaluations: z
    .array(
      z.object({
        factVersionId: z.string(),
        rationale: z.string(),
        evidence: z.array(z.string()).default([]),
        matchedText: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "For a lingering verdict, an exact verbatim span from a cited artifact excerpt that establishes the complete obsolete statement, including every version-distinguishing detail, as current. Mere compatibility is insufficient. Omit for forgotten.",
          ),
        verdict: z.enum(["forgotten", "lingering"]),
      }),
    )
    .default([]),
});

/**
 * Raw accountable text-unit classification and assertion-extraction output.
 *
 * Fields are ordered reasoning-first: the extractor writes its `rationale`
 * before committing a `classification`, so the label is conditioned on the
 * completed reasoning rather than fixed before it.
 */
export const assertionExtractionOutputSchema = z.object({
  /**
   * One classified result per requested text unit. Defaults to an empty array so
   * a degenerate tool-call payload (Anthropic structured output is forced tool
   * use, and the model can return `{}`) parses to an empty extraction and flows
   * into the per-unit degrade path rather than crashing the whole pass at the
   * schema boundary. Every requested unit is still reconciled by
   * `resolveExtractionUnit`, so a missing unit is repaired or warned, never
   * silently dropped.
   */
  units: z
    .array(
      z.object({
        unitId: z.string(),
        rationale: z.string().trim().min(1),
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
            sourceQuote: z
              .string()
              .min(1)
              .refine((value) => value.trim().length > 0, {
                message: "sourceQuote must contain non-whitespace text",
              })
              .describe(
                "The smallest exact contiguous verbatim span from the supplied text unit that supports this assertion.",
              ),
            tense: z.enum(["current", "historical"]),
          }),
        ),
      }),
    )
    .default([]),
});

/**
 * Enforce the precision-judgment cross-field invariant: `formerlyTrue` must be
 * present exactly when the verdict is `contradicted` (it distinguishes a stale
 * claim from an invented one; a `supported` or `not-addressed` claim has no such
 * flag).
 *
 * This is attached to the strict single-item schema used by isolated repair
 * calls. The batch schema deliberately omits it and defers the identical check
 * to per-item resolution (see `resolveJudgments`), so one malformed element
 * degrades to a fallback verdict instead of failing the whole batch parse.
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
 * One raw source-grounding evaluation for an extracted claim, before the
 * cross-field invariant is applied. `supported` and `contradicted` cite the
 * source evidence that establishes the verdict; `not-addressed` cites none.
 *
 * Fields are ordered reasoning-first: the classifier writes its `rationale` and
 * cites `evidenceIds` before committing a `verdict`, and sets `formerlyTrue`
 * (a sub-flag of `contradicted`) only after the verdict it depends on. The
 * label is thus conditioned on the completed reasoning rather than fixed before
 * it, so a rationale that reasons its way to a conclusion can no longer disagree
 * with an already-emitted verdict.
 */
const precisionJudgmentEvaluationSchema = z.object({
  assertionId: z.string(),
  rationale: z.string().trim().min(1),
  evidenceIds: z.array(z.string()).default([]),
  verdict: z.enum(["supported", "contradicted", "not-addressed"]),
  formerlyTrue: z.boolean().optional(),
});

/**
 * Strict source-grounding output for a single isolated repair, where the
 * cross-field invariant is enforced at parse time so the model gets a retry
 * before the element is degraded.
 */
export const precisionJudgmentOutputSchema = z.object({
  evaluations: z.array(
    precisionJudgmentEvaluationSchema.superRefine(refineFormerlyTrue),
  ),
});

/**
 * Lenient source-grounding output for a batch. Parsing does not reject the whole
 * array when one element violates the cross-field invariant; that rule is
 * enforced per element by `resolveJudgments`, so a single bad element can
 * degrade to `unverified` while its neighbors survive.
 */
export const precisionJudgmentBatchOutputSchema = z.object({
  evaluations: z.array(precisionJudgmentEvaluationSchema),
});

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
 * Inferred type of precision-judgment output.
 */
export type PrecisionJudgmentOutput = z.infer<
  typeof precisionJudgmentOutputSchema
>;
