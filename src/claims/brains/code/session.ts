import { randomUUID } from "node:crypto";
import {
  ClaimsError,
  ClaimsPageMissingError,
  ClaimsPersistenceSecurityError,
  ClaimSessionError,
  EvidenceSecurityError,
} from "../../core/errors.js";
import { applyClaimOperations, cloneClaims } from "../../core/mutations.js";
import { cacheEvidenceResolver } from "../../core/resolver-cache.js";
import type { Claim, EvidenceResolver } from "../../core/types.js";
import { normalizeWikiPagePath } from "./paths.js";
import { ClaimsStore } from "./store.js";
import {
  CODE_CLAIMS_SCHEMA_VERSION,
  type ClaimsFinalizeResult,
  type ClaimsPageVersionRefreshResult,
  type ClaimsVerificationEvent,
  type GroundingIssue,
  type InspectedClaim,
  type PageClaims,
  type ResolveClaimsInput,
  type ResolveClaimsResult,
} from "./types.js";

/**
 * Injectable dependencies and persisted state for one Claims session.
 */
export interface ClaimSessionOptions {
  /**
   * Deterministic repository evidence resolver.
   */
  resolver: EvidenceResolver;

  /**
   * Valid persisted page state loaded before the run.
   */
  persisted: Map<string, PageClaims>;

  /**
   * Lazy page-local evidence issues detected during preflight.
   */
  issues: GroundingIssue[];

  /**
   * Sidecars whose generated Markdown pages no longer exist.
   */
  orphanPages: string[];

  /**
   * Identifier factory used for newly added claims.
   *
   * @default A `claim_`-prefixed cryptographically random UUID.
   */
  createClaimId?: () => string;
}

/**
 * Mutable run-scoped state for one generated page.
 */
interface WorkingPageState {
  /**
   * Complete current proposition set.
   */
  claims: Claim[];

  /**
   * Last successfully persisted complete reconciliation event.
   */
  verification?: ClaimsVerificationEvent;

  /**
   * Whether this working page currently has a persisted sidecar.
   */
  persisted: boolean;

  /**
   * Completion gate for the latest queued mutation.
   */
  pendingMutation: Promise<void>;

  /**
   * Whether claim state changed and requires persistence.
   */
  dirty: boolean;

  /**
   * Whether the owning Markdown page was successfully deleted.
   */
  deleted: boolean;

  /**
   * Evidence issues not yet resolved by a claim operation.
   */
  issues: GroundingIssue[];
}

/**
 * Run-scoped claim state with lazy inspection and dirty-only persistence.
 */
export class ClaimSession {
  /**
   * Deterministic repository evidence resolver.
   */
  private readonly resolver: EvidenceResolver;

  /**
   * Working page state keyed by canonical virtual path.
   */
  private readonly pages = new Map<string, WorkingPageState>();

  /**
   * Current generated-page owner for every globally unique claim identifier.
   */
  private readonly claimOwners = new Map<string, string>();

  /**
   * Sidecars eligible for deterministic successful-run cleanup.
   */
  private readonly orphanPages: string[];

  /**
   * OpenWiki-owned identifier factory.
   */
  private readonly createClaimId: () => string;

  /**
   * Creates a run-scoped Claims session from persisted state and preflight.
   *
   * @param options - Resolver, persisted claims, lazy issues, and orphan pages.
   */
  constructor(options: ClaimSessionOptions) {
    this.resolver = options.resolver;
    this.orphanPages = [
      ...new Set(options.orphanPages.map(normalizeWikiPagePath)),
    ].sort((left, right) => left.localeCompare(right));
    this.createClaimId =
      options.createClaimId ??
      (() => `claim_${randomUUID().replaceAll("-", "")}`);

    for (const [pageInput, persisted] of options.persisted) {
      const page = normalizeWikiPagePath(pageInput);
      if (this.pages.has(page)) {
        throw new ClaimSessionError(`Duplicate persisted claim page: ${page}`);
      }
      this.assertClaimOwnershipAvailable(page, persisted.claims);
      for (const claim of persisted.claims) {
        this.claimOwners.set(claim.id, page);
      }
      this.pages.set(page, {
        claims: cloneClaims(persisted.claims),
        ...(persisted.verification
          ? { verification: { ...persisted.verification } }
          : {}),
        persisted: true,
        pendingMutation: Promise.resolve(),
        dirty: false,
        deleted: false,
        issues: options.issues
          .filter((issue) => normalizeWikiPagePath(issue.page) === page)
          .map(cloneGroundingIssue),
      });
    }
  }

  /**
   * Atomically validates, resolves, and applies a page-local mutation batch.
   *
   * Successful operations mark only the owning page dirty and clear issues for
   * the claim identifiers they target.
   *
   * @param input - Canonical page and ordered claim operations.
   * @returns Canonical page and compact per-operation results.
   */
  async resolveClaims(input: ResolveClaimsInput): Promise<ResolveClaimsResult> {
    const page = normalizeWikiPagePath(input.page);
    const state = this.getOrCreatePage(page);
    const previousMutation = state.pendingMutation;
    let releaseMutation = (): void => undefined;
    state.pendingMutation = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    await previousMutation;

    try {
      const existingIds = new Set(state.claims.map(({ id }) => id));
      const previousClaims = state.claims;
      const nextClaims = await applyClaimOperations({
        claims: state.claims,
        operations: input.operations,
        resolver: this.resolver,
        createClaimId: () => this.allocateClaimId(),
      });
      this.assertClaimOwnershipAvailable(page, nextClaims);
      this.replaceClaimOwnership(page, previousClaims, nextClaims);
      state.claims = nextClaims;
      const allocatedIds = nextClaims
        .map(({ id }) => id)
        .filter((id) => !existingIds.has(id));
      let nextAllocatedId = 0;
      const results = input.operations.map((operation) => ({
        op: operation.op,
        id:
          operation.op === "add"
            ? allocatedIds[nextAllocatedId++]
            : operation.id,
      }));
      state.dirty = true;
      state.deleted = false;
      const targetedIds = new Set(results.map(({ id }) => id));
      state.issues = state.issues.filter(
        (issue) => !targetedIds.has(issue.claimId),
      );
      return { page, results };
    } finally {
      releaseMutation();
    }
  }

  /**
   * Returns compact claim state without creating a write obligation.
   *
   * @param pageInput - Virtual generated-page path.
   * @returns Complete cloned model-facing claims without opaque evidence versions.
   */
  inspectClaims(pageInput: string): InspectedClaim[] {
    const page = normalizeWikiPagePath(pageInput);
    const state = this.getOrCreatePage(page);
    if (state.deleted) {
      return [];
    }
    return state.claims.map((claim) => toInspectedClaim(claim, state.issues));
  }

  /**
   * Returns the complete current evidence-resource projection for every page
   * represented in this Claims session.
   *
   * Resources are deduplicated and sorted per page so OKF provenance output is
   * deterministic. Deleted pages are omitted; an empty Claims set remains in
   * the map so a prior code-owned `sources` projection can be removed.
   *
   * @returns Detached page-to-resource state for deterministic finalizers.
   */
  getEvidenceResourcesByPage(): ReadonlyMap<string, readonly string[]> {
    const result = new Map<string, readonly string[]>();
    const pages = [...this.pages.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    );
    for (const [page, state] of pages) {
      if (state.deleted) continue;
      const resources = state.claims.flatMap((claim) =>
        claim.evidence.map(({ resource }) => resource),
      );
      result.set(
        page,
        [...new Set(resources)].sort((left, right) =>
          left.localeCompare(right),
        ),
      );
    }
    return result;
  }

  /**
   * Records a successful Markdown deletion so its sidecar follows automatically.
   *
   * @param pageInput - Virtual generated-page path confirmed by the backend.
   */
  async recordDeletion(pageInput: string): Promise<void> {
    const page = normalizeWikiPagePath(pageInput);
    const state = this.getOrCreatePage(page);
    await state.pendingMutation;
    this.replaceClaimOwnership(page, state.claims, []);
    state.deleted = true;
    state.dirty = false;
    state.issues = [];
  }

  /**
   * Persists explicitly changed claims and removes deleted or orphaned sidecars.
   *
   * Every dirty page is rechecked against current evidence and its Markdown is
   * hashed before any sidecar is changed. Unrelated claim state remains intact.
   *
   * @param store - OpenWiki-owned Claims persistence.
   */
  async finalize(
    store: ClaimsStore,
    verification: ClaimsVerificationEvent,
    excludedPages: ReadonlySet<string> = new Set(),
  ): Promise<ClaimsFinalizeResult> {
    const resolver = cacheEvidenceResolver(this.resolver);
    const warnings: string[] = [];
    const verificationByPage = new Map<
      string,
      ClaimsVerificationEvent | null
    >();
    const missingPages: string[] = [];
    const ready: Array<{
      page: string;
      state: WorkingPageState;
      hash: string;
    }> = [];

    for (const [page, state] of this.pages) {
      if (excludedPages.has(page)) continue;
      await state.pendingMutation;
      if (state.deleted || !state.dirty) {
        continue;
      }
      try {
        if (state.issues.length > 0) {
          throw new ClaimSessionError(
            `Unresolved evidence debt remains for ${page}`,
          );
        }
        await this.assertEvidenceStillCurrent(page, state.claims, resolver);
        ready.push({ page, state, hash: await store.hashPage(page) });
      } catch (error) {
        if (!isRecoverableFinalizationError(error)) {
          throw error;
        }
        if (error instanceof ClaimsPageMissingError) {
          missingPages.push(page);
          warnings.push(
            `Could not verify Claims for ${page} because its Markdown disappeared; its sidecar will be removed: ${error.message}`,
          );
        } else {
          warnings.push(formatFinalizationWarning(page, "verify", error));
        }
      }
    }

    for (const orphan of this.orphanPages) {
      if (excludedPages.has(orphan)) continue;
      try {
        await store.deletePage(orphan);
      } catch (error) {
        if (!isRecoverableFinalizationError(error)) {
          throw error;
        }
        warnings.push(formatFinalizationWarning(orphan, "clean up", error));
      }
    }
    for (const missingPage of missingPages) {
      if (excludedPages.has(missingPage)) continue;
      try {
        await store.deletePage(missingPage);
      } catch (error) {
        if (!isRecoverableFinalizationError(error)) {
          throw error;
        }
        warnings.push(formatFinalizationWarning(missingPage, "remove", error));
      }
    }
    for (const [page, state] of this.pages) {
      if (excludedPages.has(page)) continue;
      if (state.deleted) {
        try {
          await store.deletePage(page);
        } catch (error) {
          if (!isRecoverableFinalizationError(error)) {
            throw error;
          }
          warnings.push(formatFinalizationWarning(page, "remove", error));
        }
      }
    }
    for (const { page, state, hash } of ready) {
      const nextVerification =
        state.claims.length > 0 ? { ...verification } : undefined;
      try {
        await store.writePage(page, {
          schemaVersion: CODE_CLAIMS_SCHEMA_VERSION,
          pageVersion: hash,
          claims: cloneClaims(state.claims),
          ...(nextVerification ? { verification: nextVerification } : {}),
        });
        state.verification = nextVerification;
        state.persisted = true;
        state.dirty = false;
      } catch (error) {
        if (!isRecoverableFinalizationError(error)) {
          throw error;
        }
        warnings.push(formatFinalizationWarning(page, "persist", error));
      }
    }

    for (const [page, state] of this.pages) {
      if (excludedPages.has(page)) continue;
      if (state.deleted) continue;
      const eligible =
        state.persisted &&
        !state.dirty &&
        state.claims.length > 0 &&
        state.issues.length === 0 &&
        state.verification !== undefined;
      verificationByPage.set(
        page,
        eligible ? { ...state.verification! } : null,
      );
    }

    return { verificationByPage, warnings };
  }

  /**
   * Refreshes persisted page hashes after OKF verification projection.
   *
   * A failed refresh is reported per page so the caller can roll back a newly
   * exposed machine stamp. Debt-driven removals remain removed even when their
   * historical sidecar hash cannot be refreshed.
   *
   * @param store - OpenWiki-owned Claims persistence.
   * @param pages - Pages whose Markdown changed during projection.
   */
  async refreshPageVersions(
    store: ClaimsStore,
    pages: readonly string[],
  ): Promise<ClaimsPageVersionRefreshResult> {
    const warnings: string[] = [];
    const failedPages: string[] = [];

    for (const pageInput of [...new Set(pages)].sort((left, right) =>
      left.localeCompare(right),
    )) {
      const page = normalizeWikiPagePath(pageInput);
      const state = this.pages.get(page);
      if (!state || !state.persisted || state.deleted || state.dirty) continue;
      try {
        await store.writePage(page, {
          schemaVersion: CODE_CLAIMS_SCHEMA_VERSION,
          pageVersion: await store.hashPage(page),
          claims: cloneClaims(state.claims),
          ...(state.verification
            ? { verification: { ...state.verification } }
            : {}),
        });
      } catch (error) {
        if (!isRecoverableFinalizationError(error)) {
          throw error;
        }
        failedPages.push(page);
        warnings.push(formatFinalizationWarning(page, "synchronize", error));
      }
    }

    return { failedPages, warnings };
  }

  /**
   * Verifies that dirty claims still match the evidence accepted this run.
   *
   * @param page - Canonical generated-page path used in diagnostics.
   * @param claims - Complete claims about to be persisted.
   * @param resolver - Finalization-pass cached evidence resolver.
   */
  private async assertEvidenceStillCurrent(
    page: string,
    claims: readonly Claim[],
    resolver: EvidenceResolver,
  ): Promise<void> {
    for (const claim of claims) {
      for (const evidence of claim.evidence) {
        const current = await resolver.resolve(
          evidence.resource,
          evidence.version,
        );
        if (!current) {
          throw new ClaimSessionError(
            `Evidence disappeared before finalizing ${page}: ${evidence.resource}`,
          );
        }
        if (current.evidence.version !== evidence.version) {
          throw new ClaimSessionError(
            `Evidence changed before finalizing ${page}: ${evidence.resource}`,
          );
        }
      }
    }
  }

  /**
   * Gets or initializes empty working state for a newly claimed page.
   *
   * @param page - Canonical generated-page path.
   * @returns Existing or newly allocated mutable page state.
   */
  private getOrCreatePage(page: string): WorkingPageState {
    const existing = this.pages.get(page);
    if (existing) {
      return existing;
    }
    const created: WorkingPageState = {
      claims: [],
      persisted: false,
      pendingMutation: Promise.resolve(),
      dirty: false,
      deleted: false,
      issues: [],
    };
    this.pages.set(page, created);
    return created;
  }

  /**
   * Allocates an identifier that is unused across every current page.
   *
   * The core mutation layer separately protects against duplicates created
   * within one operation batch. This guard covers identifiers already owned by
   * other generated pages.
   *
   * @returns Globally unused OpenWiki-owned claim identifier.
   */
  private allocateClaimId(): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const id = this.createClaimId();
      if (!this.claimOwners.has(id)) {
        return id;
      }
    }
    throw new ClaimSessionError(
      "Unable to allocate a globally unique claim identifier.",
    );
  }

  /**
   * Rejects a page state containing an identifier owned by another page.
   *
   * @param page - Canonical page that would own the supplied claims.
   * @param claims - Proposed complete claim state for that page.
   */
  private assertClaimOwnershipAvailable(
    page: string,
    claims: readonly Claim[],
  ): void {
    const pageIds = new Set<string>();
    for (const claim of claims) {
      if (pageIds.has(claim.id)) {
        throw new ClaimSessionError(
          `Duplicate claim id ${claim.id} within ${page}`,
        );
      }
      pageIds.add(claim.id);
      const owner = this.claimOwners.get(claim.id);
      if (owner && owner !== page) {
        throw new ClaimSessionError(
          `Duplicate claim id ${claim.id} across ${owner} and ${page}`,
        );
      }
    }
  }

  /**
   * Replaces the global identifier ownership contributed by one page.
   *
   * @param page - Canonical page whose complete state changed.
   * @param previousClaims - Claims owned before the change.
   * @param nextClaims - Claims owned after the change.
   */
  private replaceClaimOwnership(
    page: string,
    previousClaims: readonly Claim[],
    nextClaims: readonly Claim[],
  ): void {
    const nextIds = new Set(nextClaims.map(({ id }) => id));
    for (const { id } of previousClaims) {
      if (!nextIds.has(id) && this.claimOwners.get(id) === page) {
        this.claimOwners.delete(id);
      }
    }
    for (const { id } of nextClaims) {
      this.claimOwners.set(id, page);
    }
  }
}

/**
 * Removes opaque evidence versions from one model-facing claim clone.
 *
 * @param claim - Authoritative current claim.
 * @param issues - Page-local evidence issues detected during preflight.
 * @returns Detached compact claim suitable for tool output.
 */
function toInspectedClaim(
  claim: Claim,
  issues: readonly GroundingIssue[],
): InspectedClaim {
  const issue = issues.find((item) => item.claimId === claim.id);
  return {
    id: claim.id,
    statement: claim.statement,
    evidence: claim.evidence.map(({ resource }) => resource),
    ...(issue
      ? {
          issue: {
            kind: issue.kind,
            resources: [...issue.resources],
          },
        }
      : {}),
  };
}

/**
 * Clones one grounding issue across session ownership boundaries.
 *
 * @param issue - Persisted preflight issue.
 * @returns Structurally independent issue state.
 */
function cloneGroundingIssue(issue: GroundingIssue): GroundingIssue {
  return { ...issue, resources: [...issue.resources] };
}

/**
 * Identifies page-local Claims failures that can be safely deferred.
 *
 * Security failures and unexpected programmer errors remain fatal.
 *
 * @param error - Unknown finalization failure.
 * @returns Whether finalization may skip the affected page.
 */
function isRecoverableFinalizationError(error: unknown): error is ClaimsError {
  return (
    error instanceof ClaimsError &&
    !(error instanceof ClaimsPersistenceSecurityError) &&
    !(error instanceof EvidenceSecurityError)
  );
}

/**
 * Formats one page-local finalization warning.
 *
 * @param page - Canonical generated page.
 * @param action - Finalization action that was skipped.
 * @param error - Recoverable Claims failure.
 * @returns User-facing warning text.
 */
function formatFinalizationWarning(
  page: string,
  action: string,
  error: ClaimsError,
): string {
  return `Could not ${action} Claims for ${page}; its Claims sidecar was left unchanged: ${error.message}`;
}
