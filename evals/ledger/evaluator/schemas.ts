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
 * Raw required-ledger accounting output for extracted artifact assertions.
 */
export const precisionLedgerOutputSchema = z.object({
  evaluations: z.array(
    z
      .object({
        assertionId: z.string(),
        verdict: z.enum(["supported", "contradicted", "unaccounted"]),
        factVersionIds: z.array(z.string()).default([]),
        formerlyTrue: z.boolean().optional(),
        rationale: z.string().trim().min(1),
      })
      .superRefine((evaluation, context) => {
        if (
          (evaluation.verdict === "contradicted") !==
          (evaluation.formerlyTrue !== undefined)
        ) {
          context.addIssue({
            code: "custom",
            path: ["formerlyTrue"],
            message:
              "formerlyTrue is required exactly when verdict is contradicted",
          });
        }
      }),
  ),
});

/**
 * Raw refutation output for current, off-ledger claims.
 */
export const precisionJudgmentOutputSchema = z.object({
  evaluations: z.array(
    z
      .object({
        assertionId: z.string(),
        verdict: z.enum(["contradicted", "not-refuted"]),
        evidenceIds: z.array(z.string()).default([]),
        formerlyTrue: z.boolean().optional(),
        rationale: z.string().trim().min(1),
      })
      .superRefine((evaluation, context) => {
        if (
          (evaluation.verdict === "contradicted") !==
          (evaluation.formerlyTrue !== undefined)
        ) {
          context.addIssue({
            code: "custom",
            path: ["formerlyTrue"],
            message:
              "formerlyTrue is required exactly when verdict is contradicted",
          });
        }
      }),
  ),
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
