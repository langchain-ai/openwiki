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
 * Raw assertion-extraction output: exactly one assertion list for every
 * artifact section supplied to the classifier.
 */
export const assertionExtractionOutputSchema = z.object({
  sections: z.array(
    z.object({
      sectionId: z.string(),
      assertions: z.array(z.string().trim().min(1)),
    }),
  ),
});

/**
 * Raw precision-judgment output: one support verdict for every code-owned
 * assertion ID supplied to the classifier.
 */
export const precisionJudgmentOutputSchema = z.object({
  evaluations: z.array(
    z.object({
      assertionId: z.string(),
      verdict: z.enum(["supported", "contradicted", "unverifiable"]),
      evidenceIds: z.array(z.string()).default([]),
      rationale: z.string().trim().min(1),
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
 * Inferred type of precision-judgment output.
 */
export type PrecisionJudgmentOutput = z.infer<
  typeof precisionJudgmentOutputSchema
>;
