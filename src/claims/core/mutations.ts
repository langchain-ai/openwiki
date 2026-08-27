import { randomUUID } from "node:crypto";
import { ClaimSessionError } from "./errors.js";
import { cacheEvidenceResolver } from "./resolver-cache.js";
import type {
  Claim,
  ClaimOperation,
  Evidence,
  EvidenceResolver,
  ProposedEvidence,
} from "./types.js";

/**
 * Inputs for one atomic generic claim-set mutation.
 */
export interface ApplyClaimOperationsInput {
  /**
   * Complete current claim set for one brain-owned subject.
   */
  claims: readonly Claim[];

  /**
   * Ordered mutations proposed by an agent or application.
   */
  operations: readonly ClaimOperation[];

  /**
   * Resolver for the evidence namespace accepted by the owning brain.
   */
  resolver: EvidenceResolver;

  /**
   * Identifier factory used for newly added claims.
   *
   * @default a `claim_`-prefixed cryptographically random UUID.
   */
  createClaimId?: () => string;
}

/**
 * Validates, resolves, and applies a mutation batch without partial changes.
 *
 * @param input - Current claims, operations, resolver, and optional ID factory.
 * @returns A structurally independent complete claim set.
 */
export async function applyClaimOperations(
  input: ApplyClaimOperationsInput,
): Promise<Claim[]> {
  if (input.operations.length === 0) {
    throw new ClaimSessionError(
      "A claim mutation requires at least one operation.",
    );
  }

  const createClaimId =
    input.createClaimId ?? (() => `claim_${randomUUID().replaceAll("-", "")}`);
  validateClaims(input.claims);
  const working = cloneClaims(input.claims);
  const reservedIds = new Set(input.claims.map((claim) => claim.id));
  const targetedIds = new Set<string>();
  const resolvedByOperation = new Map<number, Evidence[]>();
  const resolver = cacheEvidenceResolver(input.resolver);

  for (const operation of input.operations) {
    validateOperation(operation);
    if (operation.op !== "add") {
      if (targetedIds.has(operation.id)) {
        throw new ClaimSessionError(
          `Claim ${operation.id} is targeted more than once in one batch.`,
        );
      }
      targetedIds.add(operation.id);
      if (!reservedIds.has(operation.id)) {
        throw new ClaimSessionError(`Unknown claim id: ${operation.id}`);
      }
    }
  }

  for (const [index, operation] of input.operations.entries()) {
    if (operation.op === "add") {
      resolvedByOperation.set(
        index,
        await resolveEvidence(operation.evidence, resolver),
      );
      continue;
    }
    if (operation.op === "confirm" || operation.op === "update") {
      const current = working.find((claim) => claim.id === operation.id);
      if (!current) {
        throw new ClaimSessionError(`Unknown claim id: ${operation.id}`);
      }
      const proposed =
        operation.op === "update" && operation.evidence !== undefined
          ? operation.evidence
          : current.evidence;
      resolvedByOperation.set(index, await resolveEvidence(proposed, resolver));
    }
  }

  for (const [index, operation] of input.operations.entries()) {
    if (operation.op === "add") {
      working.push({
        id: createUniqueClaimId(reservedIds, createClaimId),
        statement: operation.statement.trim(),
        evidence: requireResolvedEvidence(resolvedByOperation, index),
      });
      continue;
    }

    const claimIndex = working.findIndex((claim) => claim.id === operation.id);
    if (claimIndex === -1) {
      throw new ClaimSessionError(`Unknown claim id: ${operation.id}`);
    }
    if (operation.op === "retract") {
      working.splice(claimIndex, 1);
      continue;
    }
    const current = working[claimIndex];
    working[claimIndex] = {
      id: operation.id,
      statement:
        operation.op === "update" && operation.statement !== undefined
          ? operation.statement.trim()
          : current.statement,
      evidence: requireResolvedEvidence(resolvedByOperation, index),
    };
  }

  return cloneClaims(working);
}

/**
 * Resolves and validates one complete proposed evidence set.
 *
 * @param evidenceInputs - Proposed identities or persisted evidence to resolve.
 * @param resolver - Cached resolver for the owning evidence namespace.
 * @returns Canonical evidence identities and their current versions.
 */
async function resolveEvidence(
  evidenceInputs: readonly (ProposedEvidence | Evidence)[],
  resolver: EvidenceResolver,
): Promise<Evidence[]> {
  const evidence: Evidence[] = [];
  const inputResources = new Set<string>();
  const resolvedResources = new Set<string>();
  for (const input of evidenceInputs) {
    if (inputResources.has(input.resource)) {
      throw new ClaimSessionError(`Claim evidence repeats ${input.resource}`);
    }
    inputResources.add(input.resource);
    const previousVersion = "version" in input ? input.version : undefined;
    const resolved = await resolver.resolve(input.resource, previousVersion);
    if (!resolved) {
      throw new ClaimSessionError(
        `Evidence does not resolve: ${input.resource}`,
      );
    }
    validateEvidence(resolved.evidence, "Resolved evidence");
    if (resolvedResources.has(resolved.evidence.resource)) {
      throw new ClaimSessionError(
        `Claim evidence resolves to duplicate resource ${resolved.evidence.resource}`,
      );
    }
    resolvedResources.add(resolved.evidence.resource);
    evidence.push(resolved.evidence);
  }
  return evidence;
}

/**
 * Validates the complete starting claim set before resolving mutations.
 *
 * @param claims - Existing generic claim state.
 */
function validateClaims(claims: readonly Claim[]): void {
  const ids = new Set<string>();
  for (const claim of claims) {
    requireCanonicalNonEmpty(claim.id, "Claim id");
    if (ids.has(claim.id)) {
      throw new ClaimSessionError(`Duplicate claim id: ${claim.id}`);
    }
    ids.add(claim.id);
    requireCanonicalNonEmpty(claim.statement, `Claim ${claim.id} statement`);
    if (claim.evidence.length === 0) {
      throw new ClaimSessionError(
        `Claim ${claim.id} requires at least one evidence resource.`,
      );
    }
    const resources = new Set<string>();
    for (const evidence of claim.evidence) {
      validateEvidence(evidence, `Claim ${claim.id} evidence`);
      if (resources.has(evidence.resource)) {
        throw new ClaimSessionError(
          `Claim ${claim.id} repeats evidence ${evidence.resource}`,
        );
      }
      resources.add(evidence.resource);
    }
  }
}

/**
 * Validates one resolver-owned evidence identity and version.
 *
 * @param evidence - Evidence returned by a resolver or loaded as current state.
 * @param label - Diagnostic owner label.
 */
function validateEvidence(evidence: Evidence, label: string): void {
  requireCanonicalNonEmpty(evidence.resource, `${label} resource`);
  requireCanonicalNonEmpty(evidence.version, `${label} version`);
}

/**
 * Returns pre-resolved evidence for an add or update operation.
 *
 * @param resolvedByOperation - Evidence keyed by operation index.
 * @param index - Current operation index.
 * @returns Complete resolved evidence.
 */
function requireResolvedEvidence(
  resolvedByOperation: ReadonlyMap<number, Evidence[]>,
  index: number,
): Evidence[] {
  const evidence = resolvedByOperation.get(index);
  if (!evidence) {
    throw new ClaimSessionError("Resolved claim evidence is missing.");
  }
  return evidence;
}

/**
 * Validates one operation before any cloned state is changed.
 *
 * @param operation - Proposed claim operation.
 */
function validateOperation(operation: ClaimOperation): void {
  if (operation.op === "retract") {
    requireCanonicalNonEmpty(operation.id, "Retract claim id");
    return;
  }
  if (operation.op === "confirm") {
    requireCanonicalNonEmpty(operation.id, "Confirm claim id");
    return;
  }
  if (operation.op === "update") {
    requireCanonicalNonEmpty(operation.id, "Update claim id");
    if (operation.statement === undefined && operation.evidence === undefined) {
      throw new ClaimSessionError(
        "An update requires a statement or evidence change.",
      );
    }
  }
  if (operation.op !== "add" && operation.op !== "update") {
    throw new ClaimSessionError("Unsupported claim operation.");
  }
  if (operation.statement !== undefined && !operation.statement.trim()) {
    throw new ClaimSessionError("Claim statement cannot be empty.");
  }
  if (operation.evidence !== undefined && operation.evidence.length === 0) {
    throw new ClaimSessionError(
      "A claim requires at least one evidence resource.",
    );
  }
  for (const proposed of operation.evidence ?? []) {
    requireCanonicalNonEmpty(proposed.resource, "Proposed evidence resource");
  }
}

/**
 * Requires a stable identity string without surrounding whitespace.
 *
 * @param value - Candidate persisted identity or value.
 * @param label - Diagnostic field label.
 */
function requireCanonicalNonEmpty(value: string, label: string): void {
  if (!value.trim()) {
    throw new ClaimSessionError(`${label} cannot be empty.`);
  }
  if (value !== value.trim()) {
    throw new ClaimSessionError(
      `${label} cannot contain surrounding whitespace.`,
    );
  }
}

/**
 * Allocates an opaque ID absent from the current claim set.
 *
 * @param reservedIds - Existing and previously allocated identifiers.
 * @param createClaimId - Owning application's identifier factory.
 * @returns Unique opaque claim ID.
 */
function createUniqueClaimId(
  reservedIds: Set<string>,
  createClaimId: () => string,
): string {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = createClaimId();
    requireCanonicalNonEmpty(id, "Generated claim id");
    if (!reservedIds.has(id)) {
      reservedIds.add(id);
      return id;
    }
  }
  throw new ClaimSessionError("Unable to allocate a unique claim identifier.");
}

/**
 * Clones claim state across ownership boundaries.
 *
 * @param claims - Claims to clone.
 * @returns Structurally independent records.
 */
export function cloneClaims(claims: readonly Claim[]): Claim[] {
  return claims.map((claim) => ({
    ...claim,
    evidence: claim.evidence.map((evidence) => ({ ...evidence })),
  }));
}
