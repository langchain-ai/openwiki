import { z } from "zod";
import { ReflectionIdInput } from "./plan-input.js";

/**
 * Canonical non-empty identifier or authored metadata string.
 */
const NonEmptyString = z.string().trim().min(1);

/**
 * Shared native/MCP schema for proposed claims without code-owned versions.
 */
export const ProposedPageClaimInput = z
  .object({
    id: NonEmptyString.optional(),
    statement: NonEmptyString,
    evidence: z.array(z.object({ resource: NonEmptyString }).strict()).min(1),
  })
  .strict();

/**
 * Shared authoring schema for sparse page sections with stable identities.
 */
export const ProposedPageSectionInput = z
  .object({
    id: NonEmptyString.optional(),
    location: NonEmptyString,
    description: NonEmptyString,
  })
  .strict();

/**
 * Shared authoring schema for exact passages and resolvable record references.
 * Passage whitespace is preserved because it participates in exact matching.
 */
export const ProposedProseBindingInput = z
  .object({
    id: NonEmptyString.optional(),
    section: NonEmptyString.describe(
      "Existing section ID or exact new section location.",
    ),
    text: z
      .string()
      .refine((value) => value.trim().length > 0, "Passage must not be empty"),
    claims: z
      .array(NonEmptyString)
      .min(1)
      .describe("Existing claim IDs or exact new claim statements."),
  })
  .strict();

/**
 * One sparse reconciliation contract shared by native and MCP page authors.
 */
export const PageReconciliationInput = z
  .object({
    confirmedClaimIds: z.array(NonEmptyString).optional(),
    claims: z.array(ProposedPageClaimInput).optional(),
    retractedClaimIds: z.array(NonEmptyString).optional(),
    sections: z.array(ProposedPageSectionInput).optional(),
    removedSectionIds: z.array(NonEmptyString).optional(),
    bindings: z.array(ProposedProseBindingInput).optional(),
    removedBindingIds: z.array(NonEmptyString).optional(),
    reflectionResults: z
      .array(
        z
          .object({
            id: ReflectionIdInput,
            claims: z
              .array(NonEmptyString)
              .describe(
                "Resulting claim IDs or exact new statements; empty only for a discarded finding.",
              ),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
