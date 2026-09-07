import { z } from "zod";
import {
  formatRepositoryEvidenceResource,
  parseRepositoryEvidenceResource,
} from "../claims/evidence/repository/resource.js";
import type { Evidence } from "../claims/core/types.js";

/**
 * Repository-relative directory for pending discoveries that travel with a PR.
 */
export const REFLECTIONS_DIRECTORY = "openwiki/.reflections";

/**
 * UUID-based reflection identity, also used as its JSON filename stem.
 */
export const REFLECTION_ID_PATTERN =
  /^reflection-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

/**
 * Strict discovery input shared by the MCP schema and storage boundary.
 */
export const ReflectionProposalSchema = z
  .object({
    finding: z
      .string()
      .trim()
      .min(1)
      .describe(
        "A repository-specific discovery and when it applies, supported by evidence and not accurately captured in the wiki.",
      ),
    evidence: z
      .array(
        z
          .object({
            resource: z
              .string()
              .trim()
              .min(1)
              .describe(
                "Repository evidence URI, for example repo://src/retry.ts#L12-L20.",
              ),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/**
 * A finding proposed by an agent before OpenWiki captures evidence versions.
 */
export type ReflectionProposal = z.infer<typeof ReflectionProposalSchema>;

/**
 * Pending repository knowledge; presence on disk means consolidation is still owed.
 */
export interface Reflection {
  /**
   * OpenWiki-generated UUID identity preserved when the file travels between branches.
   */
  id: string;

  /**
   * Reusable discovery and its conditions, awaiting verification during consolidation.
   */
  finding: string;

  /**
   * Canonical repository evidence with versions captured when the finding was recorded.
   */
  evidence: Evidence[];
}

/**
 * Artifact identity returned to the agent after successful creation.
 */
export interface ReflectionCreated {
  /**
   * Stable identity available in subsequent retrieval.
   */
  id: string;

  /**
   * Repository-relative JSON path to include with the task's changes.
   */
  path: string;
}

/**
 * Discovery navigation returned by orient, including findings with no known page.
 */
export interface WikiPageReflection extends Pick<Reflection, "id" | "finding"> {
  /**
   * Wiki-relative pages connected through shared evidence files.
   */
  relatedPages: string[];
}

/**
 * Discovery navigation returned for a page's section outline.
 */
export interface WikiSectionReflection extends Pick<
  Reflection,
  "id" | "finding"
> {
  /**
   * Stable section identities connected through claims and prose bindings.
   */
  relatedSectionIds: string[];
}

/**
 * Selected discovery and source resources for direct investigation.
 */
export interface WikiClaimReflection extends Pick<
  Reflection,
  "id" | "finding"
> {
  /**
   * Supporting resources without internal captured evidence versions.
   */
  evidence: Array<Pick<Evidence, "resource">>;

  /**
   * Relevant claims sharing evidence files, without asserting agreement or contradiction.
   */
  relatedClaimIds: string[];
}

/**
 * Explicit fallback for pending findings that cannot be classified or fully inventoried.
 */
export interface UnclassifiedReflections<T> {
  /**
   * Why origin or inventory completeness could not be established.
   */
  unavailable: string;

  /**
   * Readable findings retained without guessing whether they belong to main or local work.
   */
  reflections: T[];
}

/**
 * Pending findings split by their known main-versus-local origin.
 */
export interface ReflectionLayers<T> {
  /**
   * Locally available records proven to have appeared in main's history.
   */
  shortTerm: T[];

  /**
   * Local or branch records not found in complete main history.
   */
  working: T[];

  /**
   * Exceptional fallback that preserves readable findings and explains inventory gaps.
   */
  unclassifiedReflections?: UnclassifiedReflections<T>;
}

/**
 * Non-empty persisted text that does not silently normalize authored records on read.
 */
const StoredText = z
  .string()
  .min(1)
  .refine((value) => value === value.trim());

/**
 * Stored repository resource in canonical URI form, without resolving current source.
 */
const StoredResource = StoredText.refine((resource) => {
  try {
    return (
      formatRepositoryEvidenceResource(
        parseRepositoryEvidenceResource(resource),
      ) === resource
    );
  } catch {
    return false;
  }
}, "Evidence must use a canonical repository resource.");

/**
 * Strict on-disk reflection format, intentionally without provenance or lifecycle fields.
 */
export const ReflectionSchema: z.ZodType<Reflection> = z
  .object({
    id: z.string().regex(REFLECTION_ID_PATTERN),
    finding: StoredText,
    evidence: z
      .array(
        z.object({ resource: StoredResource, version: StoredText }).strict(),
      )
      .min(1),
  })
  .strict()
  .refine(
    ({ evidence }) =>
      new Set(evidence.map(({ resource }) => resource)).size ===
      evidence.length,
    "Reflection evidence resources must be distinct.",
  );

/**
 * Canonical persisted representation used both for publication and comparison with main.
 *
 * @param reflection - Complete versioned discovery.
 * @returns Human-readable JSON with a final newline and stable property ordering.
 */
export function serializeReflection(reflection: Reflection): string {
  return `${JSON.stringify(ReflectionSchema.parse(reflection), null, 2)}\n`;
}
