import type { Claim, ClaimOperation } from "../../core/types.js";

/**
 * Current persisted code-brain sidecar schema version.
 */
export const CODE_CLAIMS_SCHEMA_VERSION = 1;

/**
 * OpenWiki-owned grounding state for one generated Markdown page.
 */
export interface PageClaims {
  /**
   * Persisted code-brain sidecar format version.
   */
  schemaVersion: number;

  /**
   * Compatibility snapshot of the generated Markdown bytes.
   *
   * Hash drift is informational in schema v1 and does not create agent work.
   */
  pageVersion: string;

  /**
   * Complete material proposition set owned by the page.
   */
  claims: Claim[];
}

/**
 * Input accepted by the code-brain `resolve_claims` tool.
 */
export interface ResolveClaimsInput {
  /**
   * Virtual generated-page path below `/openwiki`.
   */
  page: string;

  /**
   * Atomic page-local mutations to validate and apply in order.
   */
  operations: ClaimOperation[];
}

/**
 * Compact result returned after one successful page-local mutation batch.
 */
export interface ResolveClaimsResult {
  /**
   * Canonical generated-page path owning the mutations.
   */
  page: string;

  /**
   * Applied operations with existing or newly allocated claim identifiers.
   */
  results: ResolvedClaimOperation[];
}

/**
 * Best-effort persistence result for one completed Claims run.
 */
export interface ClaimsFinalizeResult {
  /**
   * Page-local failures that were isolated instead of aborting the run.
   */
  warnings: string[];
}

/**
 * Deterministic reason an existing claim may need attention.
 */
export type GroundingIssueKind = "stale" | "unresolved";

/**
 * Page-local evidence issue surfaced lazily when the page is read.
 */
export interface GroundingIssue {
  /**
   * Generated page that owns the affected claim.
   */
  page: string;

  /**
   * Current evidence failure category.
   */
  kind: GroundingIssueKind;

  /**
   * Stable identifier of the affected claim.
   */
  claimId: string;

  /**
   * Evidence resources that are stale or unresolved.
   */
  resources: string[];
}

/**
 * Model-facing issue detail attached to an inspected claim.
 */
export interface InspectedClaimIssue {
  /**
   * Current evidence failure category.
   */
  kind: GroundingIssueKind;

  /**
   * Evidence resources responsible for the issue.
   */
  resources: string[];
}

/**
 * Compact model-facing representation of one claim.
 */
export interface InspectedClaim {
  /**
   * Stable OpenWiki-generated claim identifier.
   */
  id: string;

  /**
   * Current factual proposition.
   */
  statement: string;

  /**
   * Resolver-owned evidence identities without opaque versions.
   */
  evidence: string[];

  /**
   * Lazy evidence issue when one was detected during preflight.
   *
   * @default undefined when no issue is known.
   */
  issue?: InspectedClaimIssue;
}

/**
 * Compact inspected Claims grouped under their owning generated page.
 */
export interface InspectedPageClaims {
  /**
   * Canonical generated-page path owning the returned claims.
   */
  page: string;

  /**
   * Selected or complete model-facing Claims for the page.
   */
  claims: InspectedClaim[];
}

/**
 * Compact result for one successful claim mutation.
 */
export interface ResolvedClaimOperation {
  /**
   * Applied operation discriminator.
   */
  op: ClaimOperation["op"];

  /**
   * Existing or newly allocated stable claim identifier.
   */
  id: string;
}
