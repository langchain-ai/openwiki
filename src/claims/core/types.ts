/**
 * Versioned source evidence supporting a claim.
 */
export interface Evidence {
  /**
   * Stable resolver-owned source identity.
   */
  resource: string;

  /**
   * Opaque resolver-owned version token observed when the claim was established.
   */
  version: string;
}

/**
 * A material factual proposition OpenWiki currently believes.
 */
export interface Claim {
  /**
   * Stable OpenWiki-generated identifier.
   */
  id: string;

  /**
   * Atomic factual proposition used as an artifact's factual backbone.
   */
  statement: string;

  /**
   * One or more source resources that jointly support the proposition.
   */
  evidence: Evidence[];
}

/**
 * Evidence proposed by the agent before deterministic version resolution.
 */
export interface ProposedEvidence {
  /**
   * Resolver-owned source identity without a model-supplied version.
   */
  resource: string;
}

/**
 * Adds a new claim and lets OpenWiki allocate its identifier.
 */
export interface AddClaimOperation {
  /**
   * Operation discriminator.
   */
  op: "add";

  /**
   * Atomic factual proposition to add.
   */
  statement: string;

  /**
   * Source resources that jointly support the proposition.
   */
  evidence: ProposedEvidence[];
}

/**
 * Confirms an existing claim against the current versions of its evidence.
 */
export interface ConfirmClaimOperation {
  /**
   * Operation discriminator.
   */
  op: "confirm";

  /**
   * Stable identifier of the claim to confirm.
   */
  id: string;
}

/**
 * Partially revises an existing stable claim.
 */
export interface UpdateClaimOperation {
  /**
   * Operation discriminator.
   */
  op: "update";

  /**
   * Stable identifier of the claim to revise.
   */
  id: string;

  /**
   * Replacement proposition.
   *
   * @default The current statement is retained.
   */
  statement?: string;

  /**
   * Replacement source resources.
   *
   * @default The current resources are retained and their versions refreshed.
   */
  evidence?: ProposedEvidence[];
}

/**
 * Retracts an existing stable claim.
 */
export interface RetractClaimOperation {
  /**
   * Operation discriminator.
   */
  op: "retract";

  /**
   * Stable identifier of the claim to retract.
   */
  id: string;
}

/**
 * One atomic mutation accepted by the Claims reconciliation boundary.
 */
export type ClaimOperation =
  | AddClaimOperation
  | ConfirmClaimOperation
  | UpdateClaimOperation
  | RetractClaimOperation;

/**
 * Current resolved representation of one evidence resource.
 */
export interface ResolvedEvidence {
  /**
   * Persistable evidence identity and version.
   */
  evidence: Evidence;

  /**
   * Exact current source content represented by the evidence.
   */
  content: string;
}

/**
 * Generic resolver for one evidence namespace.
 */
export interface EvidenceResolver {
  /**
   * Resolves the current source identity and version, or `null` when it no longer exists.
   *
   * @param resource - Stable resolver-owned source identity.
   * @param previousVersion - Prior opaque version available for resolver-specific relocation.
   * @returns Current resolved evidence, or `null` for a missing resource.
   */
  resolve(
    resource: string,
    previousVersion?: string,
  ): Promise<ResolvedEvidence | null>;
}
