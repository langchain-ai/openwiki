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
 * The coverage pass's raw output: one verdict per fact the agent was asked
 * about. Evidence defaults to an empty array so an omitted field is not an
 * error.
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
 * agent was asked to look for. Keyed by `factVersionId`, so a lingering earlier
 * version is distinguished from the current one.
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
 * The precision pass's raw output: every unique material assertion the agent
 * extracted from the wiki and its judgment of each against the active ledger.
 * `supportingFactIds` names the ledger facts that support a supported assertion
 * (one or more) and defaults to empty, which is the expected value for an
 * unsupported one.
 */
export const precisionOutputSchema = z.object({
  evaluations: z.array(
    z.object({
      assertion: z.string(),
      location: z.string(),
      verdict: z.enum(["supported", "unsupported"]),
      supportingFactIds: z.array(z.string()).default([]),
      rationale: z.string(),
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
 * Inferred type of the precision pass output.
 */
export type PrecisionOutput = z.infer<typeof precisionOutputSchema>;
